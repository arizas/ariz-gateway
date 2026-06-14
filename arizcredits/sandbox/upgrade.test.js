import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "near-workspaces";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { randomBytes, createSign } from "node:crypto";
import { buildArizCreditsJs, buildLegacyArizCreditsJs } from "../src/bundle.js";
import { createDeductClient } from "../../server/arizcredits/deduct.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const FIXTURES = join(HERE, "fixtures");
const BASELINE_WASM = join(FIXTURES, "arizcredits_onchain.wasm");
const MAINNET_RPC = process.env.ARIZ_GATEWAY_NODE_URL || "https://rpc.mainnet.fastnear.com";
const BASELINE_ACCOUNT = process.env.ARIZCREDITS_BASELINE_ACCOUNT || "arizcredits.near";

const NEW_WASM_DEFAULT = resolve(
  REPO_ROOT,
  "../quickjs-rust-near/examples/fungibletoken/out/fungible_token.wasm",
);
const NEW_WASM = process.env.ARIZCREDITS_NEW_WASM || NEW_WASM_DEFAULT;
const QUICKJS_RUST_NEAR_DIR = resolve(NEW_WASM, "../../..");

const STORAGE_DEPOSIT = 1_2500_0000000000_0000000000n.toString();
const HALF_NEAR = 500_000_000_000_000_000_000_000n.toString();

async function ensureBaselineWasm() {
  if (existsSync(BASELINE_WASM)) return;
  await mkdir(FIXTURES, { recursive: true });
  console.error(
    `[arizcredits-upgrade] fetching ${BASELINE_ACCOUNT}'s wasm from ${MAINNET_RPC}`,
  );
  const res = await fetch(MAINNET_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: {
        request_type: "view_code",
        finality: "final",
        account_id: BASELINE_ACCOUNT,
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`view_code RPC failed: ${res.status} ${res.statusText}`);
  }
  const body = await res.json();
  if (body.error) {
    throw new Error(`view_code RPC error: ${JSON.stringify(body.error)}`);
  }
  const wasm = Buffer.from(body.result.code_base64, "base64");
  await writeFile(BASELINE_WASM, wasm);
  console.error(
    `[arizcredits-upgrade] cached ${wasm.length} bytes (hash ${body.result.hash}) to ${BASELINE_WASM}`,
  );
}

async function ensureNewWasm() {
  if (existsSync(NEW_WASM)) return;
  if (!existsSync(QUICKJS_RUST_NEAR_DIR)) {
    throw new Error(
      `New wasm not found at ${NEW_WASM} and the quickjs-rust-near checkout ` +
        `is not at ${QUICKJS_RUST_NEAR_DIR}. Either build it yourself or set ` +
        `ARIZCREDITS_NEW_WASM to a pre-built wasm path.`,
    );
  }
  console.error(`[arizcredits-upgrade] building new wasm in ${QUICKJS_RUST_NEAR_DIR}`);
  const build = spawnSync("./build.sh", {
    cwd: QUICKJS_RUST_NEAR_DIR,
    stdio: "inherit",
  });
  if (build.status !== 0) {
    throw new Error(
      `./build.sh in ${QUICKJS_RUST_NEAR_DIR} exited with ${build.status}. ` +
        `Check that emscripten, cargo, and binaryen are installed.`,
    );
  }
  if (!existsSync(NEW_WASM)) {
    throw new Error(`Expected ${NEW_WASM} after build, but it is missing.`);
  }
}

// Generate an ed25519 keypair for the refund_unspent signature path. The
// test substitutes `REPLACE_REFUND_SIGNATURE_PUBLIC_KEY` with this public
// key so the bundle parses; we don't actually exercise refund_unspent.
function ed25519Keypair() {
  // node:crypto generateKeyPairSync returns DER keys — for the test we
  // only need 32 random bytes as a placeholder public key.
  return new Uint8Array(randomBytes(32));
}

describe("arizcredits upgrade compatibility", () => {
  let worker;
  let root;
  let contract;
  let owner;
  let alice;
  let operator;

  const refundPubKey = ed25519Keypair();

  before(async () => {
    await ensureBaselineWasm();
    await ensureNewWasm();

    worker = await Worker.init();
    root = worker.rootAccount;

    owner = await root.createSubAccount("owner");
    alice = await root.createSubAccount("alice");
    operator = await root.createSubAccount("operator");

    // Create the contract account and deploy the BASELINE wasm.
    contract = await root.createSubAccount("ariz");
    await contract.deploy(BASELINE_WASM);

    await contract.call(contract.accountId, "new_default_meta", {
      owner_id: contract.accountId,
      total_supply: 1_000_000_000_000n.toString(),
    });

    for (const acc of [alice, operator]) {
      await acc.call(
        contract.accountId,
        "storage_deposit",
        { account_id: acc.accountId, registration_only: true },
        { attachedDeposit: STORAGE_DEPOSIT },
      );
    }
  });

  after(async () => {
    if (worker) await worker.tearDown();
  });

  // ===== Baseline =====

  test("baseline wasm: ft_transfer + ft_balance_of work", async () => {
    await contract.call(
      contract.accountId,
      "ft_transfer",
      { receiver_id: alice.accountId, amount: 5_000_000n.toString() },
      { attachedDeposit: "1" },
    );
    const balance = await contract.view("ft_balance_of", { account_id: alice.accountId });
    assert.equal(balance, "5000000");
  });

  test("baseline wasm: post_javascript with legacy JS, then call_js_func runs aiconversation.start_ai_conversation", async () => {
    const js = await buildLegacyArizCreditsJs({ refundSignaturePublicKey: refundPubKey });
    await contract.call(
      contract.accountId,
      "post_javascript",
      { javascript: js },
      { gas: "300000000000000" },
    );

    // alice starts a conversation; her balance goes down by 1_000_000.
    await alice.call(
      contract.accountId,
      "call_js_func",
      { function_name: "start_ai_conversation", conversation_id: "conv-1" },
      { gas: "300000000000000" },
    );
    const aliceAfter = await contract.view("ft_balance_of", { account_id: alice.accountId });
    assert.equal(aliceAfter, "4000000");

    const conv = await contract.view("view_js_func", {
      function_name: "view_ai_conversation",
      conversation_id: "conv-1",
    });
    // view_ai_conversation calls value_return with a JSON string; the RPC
    // parses it for us, so `conv` is already an object.
    assert.equal(conv.receiver_id, alice.accountId);
    assert.equal(conv.amount, "1000000");
  });

  test("baseline wasm: buy_tokens_for_near transfers 3 tokens for 0.5 NEAR", async () => {
    // alice buys 3 more tokens
    await alice.call(
      contract.accountId,
      "call_js_func",
      { function_name: "buy_tokens_for_near" },
      { gas: "300000000000000", attachedDeposit: HALF_NEAR },
    );
    const balance = await contract.view("ft_balance_of", { account_id: alice.accountId });
    // She had 4_000_000 after start_ai_conversation; now +3_000_000.
    assert.equal(balance, "7000000");
  });

  // Capture web4_get's response on the baseline so we can assert that the
  // upgrade doesn't change a single byte of what arizcredits.near.page serves.
  let web4GetBaselineResponse;
  test("baseline wasm: web4_get returns the AI-proxy frontend", async () => {
    const res = await contract.view("web4_get", {});
    assert.equal(res.contentType, "text/html; charset=UTF-8");
    assert.ok(res.body && res.body.length > 1000, "web4_get body should be substantial");
    web4GetBaselineResponse = res;
  });

  // ===== Upgrade =====

  test("upgrade: deploy new wasm without state migration; balances and conversation data intact", async () => {
    const aliceBefore = await contract.view("ft_balance_of", { account_id: alice.accountId });
    const convBefore = await contract.view("view_js_func", {
      function_name: "view_ai_conversation",
      conversation_id: "conv-1",
    });

    // Plain deploy of the new wasm — no init call, no migration.
    await contract.deploy(NEW_WASM);

    const aliceAfter = await contract.view("ft_balance_of", { account_id: alice.accountId });
    assert.equal(aliceAfter, aliceBefore, "alice's FT balance survived the upgrade");

    // post_javascript with the new combined bundle (aiconversation + operator deduction).
    const newJs = await buildArizCreditsJs({ refundSignaturePublicKey: refundPubKey });
    await contract.call(
      contract.accountId,
      "post_javascript",
      { javascript: newJs },
      { gas: "300000000000000" },
    );

    const convAfter = await contract.view("view_js_func", {
      function_name: "view_ai_conversation",
      conversation_id: "conv-1",
    });
    assert.deepEqual(
      convAfter,
      convBefore,
      "conversation data still readable after JS upgrade",
    );

    // arizcredits.near.page must keep serving the same bytes.
    const web4After = await contract.view("web4_get", {});
    assert.deepEqual(
      web4After,
      web4GetBaselineResponse,
      "web4_get response is byte-for-byte identical after the upgrade",
    );
  });

  test("after upgrade: legacy methods still work (start_ai_conversation, view, buy_tokens_for_near)", async () => {
    await alice.call(
      contract.accountId,
      "call_js_func",
      { function_name: "start_ai_conversation", conversation_id: "conv-2" },
      { gas: "300000000000000" },
    );
    const conv = await contract.view("view_js_func", {
      function_name: "view_ai_conversation",
      conversation_id: "conv-2",
    });
    assert.equal(conv.receiver_id, alice.accountId);
  });

  // The operator is the contract account itself: users authorise
  // `operator_account = contract.accountId`, and `deduct` is signed AS the
  // contract account (predecessor === current_account_id).
  test("after upgrade: operator deduction lifecycle (authorize → batch deduct → view → revoke)", async () => {
    const aliceBefore = BigInt(
      await contract.view("ft_balance_of", { account_id: alice.accountId }),
    );

    // alice authorises the contract (operator) to deduct up to 1_000 per day.
    await alice.call(contract.accountId, "call_js_func", {
      function_name: "authorize_deduction",
      operator_account: contract.accountId,
      max_amount_per_day: "1000",
    });

    const auth = await contract.view("view_js_func", {
      function_name: "view_authorisation",
      user: alice.accountId,
      operator_account: contract.accountId,
    });
    assert.notEqual(auth, null, "view_authorisation should not be null after authorize");
    assert.equal(auth.max_per_day, "1000");
    assert.equal(auth.spent_today, "0");

    // The contract deducts 250 from alice in a (single-entry) batch.
    const results = await contract.call(contract.accountId, "call_js_func", {
      function_name: "deduct",
      deductions: [{ user: alice.accountId, amount: "250", description: "sync" }],
    });
    assert.deepEqual(results, [
      { user: alice.accountId, status: "deducted", amount: "250" },
    ]);

    const aliceAfter = BigInt(
      await contract.view("ft_balance_of", { account_id: alice.accountId }),
    );
    assert.equal(aliceAfter, aliceBefore - 250n, "alice's balance dropped by the deduction");

    const spent = await contract.view("view_js_func", {
      function_name: "view_spent_since_reset",
      user: alice.accountId,
      operator_account: contract.accountId,
    });
    assert.equal(spent, "250");

    // Idempotency: a second deduct the same UTC day is skipped, balance unchanged.
    const again = await contract.call(contract.accountId, "call_js_func", {
      function_name: "deduct",
      deductions: [{ user: alice.accountId, amount: "250" }],
    });
    assert.equal(again[0].status, "skipped");
    assert.match(again[0].reason, /already deducted today/);
    const aliceUnchanged = BigInt(
      await contract.view("ft_balance_of", { account_id: alice.accountId }),
    );
    assert.equal(aliceUnchanged, aliceAfter, "no double-charge on same-day re-run");

    // revoke clears the authorisation.
    await alice.call(contract.accountId, "call_js_func", {
      function_name: "revoke_deduction",
      operator_account: contract.accountId,
    });
    const authAfter = await contract.view("view_js_func", {
      function_name: "view_authorisation",
      user: alice.accountId,
      operator_account: contract.accountId,
    });
    assert.equal(authAfter, null, "view_authorisation should be null after revoke");
  });

  test("after upgrade: only the contract account may deduct (caller guard)", async () => {
    // `operator` here is just a non-contract account; the guard must reject it.
    await assert.rejects(
      operator.call(contract.accountId, "call_js_func", {
        function_name: "deduct",
        deductions: [{ user: alice.accountId, amount: "1" }],
      }),
      /only the contract account may deduct/,
    );
  });

  test("after upgrade: batch deduct skips invalid entries without reverting", async () => {
    // bob is authorised + funded; stranger is unauthorised. One batch.
    const bob = await root.createSubAccount("bob");
    await bob.call(
      contract.accountId,
      "storage_deposit",
      { account_id: bob.accountId, registration_only: true },
      { attachedDeposit: STORAGE_DEPOSIT },
    );
    await bob.call(
      contract.accountId,
      "call_js_func",
      { function_name: "buy_tokens_for_near" },
      { gas: "300000000000000", attachedDeposit: HALF_NEAR },
    );
    await bob.call(contract.accountId, "call_js_func", {
      function_name: "authorize_deduction",
      operator_account: contract.accountId,
      max_amount_per_day: "1000",
    });

    const bobBefore = BigInt(
      await contract.view("ft_balance_of", { account_id: bob.accountId }),
    );

    const results = await contract.call(contract.accountId, "call_js_func", {
      function_name: "deduct",
      deductions: [
        { user: bob.accountId, amount: "400" },
        { user: "stranger.unknown", amount: "400" }, // no authorisation
      ],
    });

    assert.equal(results.length, 2);
    assert.equal(results[0].status, "deducted");
    assert.equal(results[0].amount, "400");
    assert.equal(results[1].status, "skipped");
    assert.match(results[1].reason, /no authorisation/);

    const bobAfter = BigInt(
      await contract.view("ft_balance_of", { account_id: bob.accountId }),
    );
    assert.equal(bobAfter, bobBefore - 400n, "bob deducted; the invalid entry didn't revert it");
  });

  // Exercises the REAL gateway deduct client (server/arizcredits/deduct.js)
  // against the sandbox RPC, signing as the contract account.
  test("gateway deduct client: batches a real deduct against the sandbox", async () => {
    const carol = await root.createSubAccount("carol");
    await carol.call(
      contract.accountId,
      "storage_deposit",
      { account_id: carol.accountId, registration_only: true },
      { attachedDeposit: STORAGE_DEPOSIT },
    );
    await carol.call(
      contract.accountId,
      "call_js_func",
      { function_name: "buy_tokens_for_near" },
      { gas: "300000000000000", attachedDeposit: HALF_NEAR },
    );
    await carol.call(contract.accountId, "call_js_func", {
      function_name: "authorize_deduction",
      operator_account: contract.accountId,
      max_amount_per_day: "1000",
    });

    const operatorKey = (await worker.manager.getKey(contract.accountId)).toString();
    const client = await createDeductClient({
      networkId: "sandbox",
      nodeUrl: worker.rpcAddr,
      contractId: contract.accountId,
      operatorKey,
    });

    const carolBefore = BigInt(
      await contract.view("ft_balance_of", { account_id: carol.accountId }),
    );
    const results = await client.deduct([
      { user: carol.accountId, amount: "300", description: "fastnear:30" },
    ]);
    assert.deepEqual(results, [
      { user: carol.accountId, status: "deducted", amount: "300" },
    ]);
    const carolAfter = BigInt(
      await contract.view("ft_balance_of", { account_id: carol.accountId }),
    );
    assert.equal(carolAfter, carolBefore - 300n, "client deducted carol via the sandbox");

    const auth = await client.viewAuthorisation(carol.accountId);
    assert.equal(auth.max_per_day, "1000");
  });
});
