// Gateway-driven usage metering for arizcredits.near.
//
// Model:
//  - A user calls `authorize_deduction({operator_account, max_amount_per_day})`
//    to grant the operator a per-UTC-day spending cap. The operator is always
//    the contract account itself (see `deduct`), so `operator_account` is
//    "arizcredits.near".
//  - The gateway, signing AS the contract account, calls `deduct` once per UTC
//    day with a BATCH of {user, amount} entries. ARIZ moves from each user to
//    the contract treasury (the operator == current_account_id).
//  - `deduct` only the contract account may call it (caller guard). Individual
//    entries never panic — invalid ones are skipped and reported — so one bad
//    entry can't revert the whole daily batch. A user can be deducted at most
//    once per UTC day (idempotency), so re-running the daily pass is safe.

// The contract's QuickJS rejects numeric-separator BigInt literals
// (`86_400_000n` => SyntaxError). Use the constructor form.
const ONE_DAY_MS = BigInt("86400000");

function auth_key(user, operator) {
  return `auth::${user}::${operator}`;
}

function load_auth(user, operator) {
  const raw = env.get_data(auth_key(user, operator));
  if (!raw) return null;
  return JSON.parse(raw);
}

function store_auth(user, operator, entry) {
  env.set_data(auth_key(user, operator), JSON.stringify(entry));
}

// Integer UTC day, as a string, derived from the block timestamp.
function current_day() {
  return (BigInt(env.block_timestamp_ms()) / ONE_DAY_MS).toString();
}

export function authorize_deduction() {
  const { operator_account, max_amount_per_day } = JSON.parse(env.input());
  if (!operator_account || !max_amount_per_day) {
    env.panic("must provide operator_account and max_amount_per_day");
    return;
  }
  // Validate that max_amount_per_day is a parseable u128 string.
  BigInt(max_amount_per_day);

  const user = env.predecessor_account_id();

  // Preserve any same-day deduction bookkeeping so re-authorising (e.g. to
  // raise the cap) can't reopen a second deduction for today.
  const existing = load_auth(user, operator_account);

  store_auth(user, operator_account, {
    max_per_day: String(max_amount_per_day),
    last_deduct_day: existing ? existing.last_deduct_day : "",
    spent_today: existing ? existing.spent_today : "0",
  });

  print(
    `AUTHORIZE user=${user} operator=${operator_account} max_per_day=${max_amount_per_day}`,
  );
}

export function revoke_deduction() {
  const { operator_account } = JSON.parse(env.input());
  if (!operator_account) {
    env.panic("must provide operator_account");
    return;
  }
  const user = env.predecessor_account_id();
  env.clear_data(auth_key(user, operator_account));
  print(`REVOKE user=${user} operator=${operator_account}`);
}

export function deduct() {
  // The operator is the contract account itself; ARIZ returns to the treasury.
  // Only the contract account may call this (the gateway holds a function-call
  // key on the contract restricted to `deduct`).
  const operator = env.current_account_id();
  if (env.predecessor_account_id() !== operator) {
    env.panic("only the contract account may deduct");
    return;
  }

  const input = JSON.parse(env.input());
  // Accept a batch {deductions:[...]} and, for convenience, a single
  // {user, amount} call.
  const deductions = input.deductions ||
    [{ user: input.user, amount: input.amount, description: input.description }];

  const today = current_day();
  const results = [];

  for (let i = 0; i < deductions.length; i++) {
    const d = deductions[i] || {};
    const user = d.user;
    const amount = d.amount;

    if (!user || !amount) {
      results.push({ user: user || null, status: "skipped", reason: "missing user or amount" });
      continue;
    }

    const entry = load_auth(user, operator);
    if (!entry) {
      results.push({ user, status: "skipped", reason: "no authorisation" });
      continue;
    }

    // Once per UTC day per user.
    if (entry.last_deduct_day === today) {
      results.push({ user, status: "skipped", reason: "already deducted today" });
      continue;
    }

    let requested;
    try {
      requested = BigInt(amount);
    } catch (e) {
      results.push({ user, status: "skipped", reason: "invalid amount" });
      continue;
    }
    if (requested <= BigInt(0)) {
      results.push({ user, status: "skipped", reason: "non-positive amount" });
      continue;
    }

    const max_per_day = BigInt(entry.max_per_day);
    if (requested > max_per_day) {
      results.push({ user, status: "skipped", reason: "daily cap exceeded" });
      continue;
    }

    // Pre-check balance so an underfunded entry is skipped, not panicked
    // (a panicking transfer would revert the entire batch). ft_balance_of
    // returns "0" for unregistered/unknown accounts.
    const balance = BigInt(env.ft_balance_of(user));
    if (balance < requested) {
      results.push({ user, status: "skipped", reason: "insufficient balance" });
      continue;
    }

    store_auth(user, operator, {
      max_per_day: max_per_day.toString(),
      last_deduct_day: today,
      spent_today: requested.toString(),
    });
    env.ft_transfer_internal(user, operator, requested.toString());

    results.push({ user, status: "deducted", amount: requested.toString() });
    print(`DEDUCT user=${user} operator=${operator} amount=${requested} desc=${d.description ?? ""}`);
  }

  env.value_return(JSON.stringify(results));
}

export function view_authorisation() {
  const { user, operator_account } = JSON.parse(env.input());
  const raw = env.get_data(auth_key(user, operator_account));
  env.value_return(raw || "null");
}

export function view_spent_since_reset() {
  const { user, operator_account } = JSON.parse(env.input());
  const raw = env.get_data(auth_key(user, operator_account));
  // spent_today only counts if the recorded deduction day is the current day;
  // otherwise the user's spend has effectively reset.
  let spent = "0";
  if (raw) {
    const entry = JSON.parse(raw);
    spent = entry.last_deduct_day === current_day() ? entry.spent_today : "0";
  }
  // Return the raw numeric string so callers can JSON.parse to a string and
  // pass it straight to BigInt.
  env.value_return(`"${spent}"`);
}
