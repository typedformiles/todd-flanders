#!/usr/bin/env node
/**
 * gather.js — collects all agent data from DaimonRegistry + GitHub + token balances
 *
 * outputs JSON to stdout. todd calls this via run_command("node scripts/gather.js")
 * instead of composing inline scripts each cycle.
 *
 * todd: you can modify this file if you need to track new fields.
 */

const { ethers } = require("ethers");
const https = require("https");

const BASE_RPC = process.env.BASE_RPC || "https://mainnet.base.org";
const GH_TOKEN = process.env.GH_TOKEN || "";

const REGISTRY_ADDRESS = "0x3081aE79B403587959748591bBe1a2c12AeF5167";
const DAIMON_TOKEN = "0x98c51C8E958ccCD37F798b2B9332d148E2c05D57";

const REGISTRY_ABI = [
  "function agents(address) external view returns (string repoUrl, address wallet, string name, uint256 registeredAt, uint256 lastSeen)",
  "function agentList(uint256) external view returns (address)",
  "function getAll() external view returns (tuple(string repoUrl, address wallet, string name, uint256 registeredAt, uint256 lastSeen)[])",
];

const TOKEN_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

// --- GitHub helper ---

function githubGet(path) {
  return new Promise((resolve, reject) => {
    const headers = {
      "User-Agent": "todd-flanders-agent",
      Accept: "application/vnd.github.v3+json",
    };
    if (GH_TOKEN) headers.Authorization = `token ${GH_TOKEN}`;

    const req = https.request(
      { hostname: "api.github.com", path, method: "GET", headers },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode === 200) {
            try { resolve(JSON.parse(data)); } catch { resolve(null); }
          } else if (res.statusCode === 404) {
            resolve({ _404: true });
          } else {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// --- Main ---

async function main() {
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const registry = new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, provider);
  const token = new ethers.Contract(DAIMON_TOKEN, TOKEN_ABI, provider);

  let decimals = 18;
  try { decimals = Number(await token.decimals()); } catch {}

  // Fetch all agents from registry
  let rawAgents;
  try {
    rawAgents = await registry.getAll();
  } catch (e) {
    console.error("Failed to call getAll():", e.message);
    process.exit(1);
  }

  const now = new Date();
  const agents = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Retry helper for RPC rate limits
  async function rpcCall(fn, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try { return await fn(); } catch {
        if (i < retries - 1) await sleep(500 * (i + 1));
      }
    }
    return 0n;
  }

  for (const raw of rawAgents) {
    const wallet = raw.wallet;
    const name = raw.name;
    const repoUrl = raw.repoUrl;
    const registeredAt = new Date(Number(raw.registeredAt) * 1000);
    const lastSeen = new Date(Number(raw.lastSeen) * 1000);

    // Parse GitHub owner/repo
    let repoOwner = null, repoName = null;
    const match = (repoUrl || "").match(/github\.com\/([^/]+)\/([^/]+)/);
    if (match) { repoOwner = match[1]; repoName = match[2]; }

    // Balances (sequential with retry for RPC rate limits)
    const ethBal = await rpcCall(() => provider.getBalance(wallet));
    await sleep(300);
    const daimonBal = await rpcCall(() => token.balanceOf(wallet));
    await sleep(300);

    // GitHub activity
    let lastCommit = null, cycle = null, warning = null;

    if (repoOwner && repoName) {
      const commits = await githubGet(`/repos/${repoOwner}/${repoName}/commits?per_page=5`);
      if (commits && commits._404) {
        warning = "GitHub repo not found";
      } else if (commits && commits.length > 0) {
        lastCommit = commits[0].commit.committer.date;
        for (const c of commits) {
          const m = c.commit.message.match(/cycle\s*#?(\d+)/i);
          if (m) { cycle = parseInt(m[1]); break; }
        }
      }
    } else {
      warning = "No valid GitHub URL";
    }

    // Determine status
    const hoursSinceSeen = (now - lastSeen) / (1000 * 60 * 60);
    const hoursSinceCommit = lastCommit
      ? (now - new Date(lastCommit)) / (1000 * 60 * 60)
      : Infinity;

    let status;
    if (warning === "GitHub repo not found") {
      status = "warning";
    } else if (hoursSinceSeen <= 4 && hoursSinceCommit <= 24) {
      status = "alive";
    } else if (hoursSinceSeen <= 24) {
      status = "idle";
    } else {
      status = "offline";
    }

    agents.push({
      name,
      wallet,
      repo: repoUrl,
      repoOwner,
      repoName,
      registeredAt: registeredAt.toISOString(),
      lastSeen: lastSeen.toISOString(),
      lastCommit,
      cycle,
      ethBalance: ethers.formatEther(ethBal),
      daimonBalance: ethers.formatUnits(daimonBal, decimals),
      stakedDaimon: null,
      influence: null,
      status,
      warning,
    });
  }

  // Network totals
  const networkEth = agents
    .reduce((s, a) => s + parseFloat(a.ethBalance), 0)
    .toFixed(6);
  const networkDaimon = agents
    .reduce((s, a) => s + parseFloat(a.daimonBalance), 0)
    .toFixed(2);

  const result = {
    date: now.toISOString().split("T")[0],
    updated: now.toISOString(),
    agents,
    networkEth,
    networkDaimon,
    agentCount: agents.length,
  };

  // Send heartbeat if we have a wallet key
  if (process.env.DAIMON_WALLET_KEY) {
    try {
      const wallet = new ethers.Wallet(process.env.DAIMON_WALLET_KEY, provider);
      const reg = new ethers.Contract(REGISTRY_ADDRESS, [
        "function heartbeat() external",
      ], wallet);
      const tx = await reg.heartbeat();
      await tx.wait();
      result.heartbeat = tx.hash;
    } catch (e) {
      result.heartbeat = "failed: " + e.message.slice(0, 100);
    }
  }

  // Output JSON to stdout for Todd to consume
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error("gather failed:", e.message);
  process.exit(1);
});
