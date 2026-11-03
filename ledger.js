// 가계부 데이터 처리 (server.py의 API를 브라우저 안에서 그대로 흉내 낸다).
// 데이터는 JSON 하나, 저장은 store(GitHub)가 맡는다. app.js는 서버판과 같은 api(method, path, body)로 부른다.

export const TX_TYPES = ['수입', '지출', '이체'];
export const CATEGORY_TYPES = ['수입', '지출'];
export const ACCOUNT_KINDS = ['현금', '계좌', '카드'];
const TX_SOURCES = ['web', 'excel'];

export class ApiError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.data = { error: message, ...extra };
  }
}

export function emptyData() {
  return {
    format: 1,
    next_id: { account: 1, category: 1, transaction: 1 },
    accounts: [], categories: [], budgets: [], transactions: [],
  };
}

const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// ---------------------------------------------------------------- 값 검증

function pad(n) { return String(n).padStart(2, '0'); }

export function nowIso() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function todayIso() { return nowIso().slice(0, 10); }

function validDate(y, m, d) {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function isoDate(y, m, d) {
  return validDate(y, m, d) ? `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}` : null;
}

function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError(400, '날짜는 YYYY-MM-DD 형식이어야 합니다');
  }
  const [y, m, d] = value.split('-').map(Number);
  if (!validDate(y, m, d)) throw new ApiError(400, `없는 날짜입니다: ${value}`);
  return value;
}

function parseMonth(value) {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new ApiError(400, '월은 YYYY-MM 형식이어야 합니다');
  }
  return value;
}

// 원 단위 정수. 숫자, 정수 값의 실수, '12,000' 같은 문자열을 받는다.
function parseInt_(value, field) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const text = value.replace(/,/g, '').replace(/원/g, '').trim();
    if (/^-?\d+$/.test(text)) return Number(text);
  }
  throw new ApiError(400, `${field}: 원 단위 정수여야 합니다`);
}

export function monthAdd(month, delta) {
  const index = Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) + delta;
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${pad(index % 12 + 1)}`;
}

function monthEnd(month) { return `${monthAdd(month, 1)}-01`; }

// id 또는 이름으로 계좌/카테고리를 찾는다. 둘 다 없으면 null.
function resolveRef(list, body, idKey, nameKey, label, filter = () => true) {
  const refId = body[idKey];
  const name = body[nameKey];
  if (refId !== undefined && refId !== null && refId !== '') {
    const id = parseInt_(typeof refId === 'string' ? refId : refId, idKey);
    if (!list.some(x => x.id === id && filter(x))) throw new ApiError(400, `${label}을(를) 찾을 수 없습니다: ${id}`);
    return id;
  }
  if (name !== undefined && name !== null && name !== '') {
    const found = list.find(x => x.name === String(name).trim() && filter(x));
    if (!found) throw new ApiError(400, `${label}을(를) 찾을 수 없습니다: ${name}`);
    return found.id;
  }
  return null;
}

// ---------------------------------------------------------------- 거래

function txView(data, t) {
  const name = (list, id) => list.find(x => x.id === id)?.name ?? null;
  return {
    id: t.id, date: t.date, type: t.type,
    category_id: t.category_id, category: name(data.categories, t.category_id),
    amount: t.amount,
    account_id: t.account_id, account: name(data.accounts, t.account_id),
    to_account_id: t.to_account_id, to_account: name(data.accounts, t.to_account_id),
    memo: t.memo, source: t.source, created_at: t.created_at, updated_at: t.updated_at,
  };
}

function byDateDesc(a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id; }

function getTx(data, id) {
  const t = data.transactions.find(x => x.id === id);
  if (!t) throw new ApiError(404, '거래를 찾을 수 없습니다');
  return t;
}

function listTransactions(data, query) {
  let list = data.transactions;
  if (query.month) {
    const month = parseMonth(query.month);
    list = list.filter(t => t.date.slice(0, 7) === month);
  }
  if (query.account_id) {
    const id = parseInt_(query.account_id, 'account_id');
    list = list.filter(t => t.account_id === id || t.to_account_id === id);
  }
  if (query.category_id) {
    const id = parseInt_(query.category_id, 'category_id');
    list = list.filter(t => t.category_id === id);
  }
  return [...list].sort(byDateDesc).map(t => txView(data, t));
}

function normalizeTransaction(data, body) {
  const type = body.type;
  if (!TX_TYPES.includes(type)) throw new ApiError(400, '구분은 수입, 지출, 이체 중 하나여야 합니다');
  const amount = parseInt_(body.amount, '금액');
  if (amount <= 0) throw new ApiError(400, '금액은 0보다 커야 합니다');
  const accountId = resolveRef(data.accounts, body, 'account_id', 'account', '계좌');
  if (accountId === null) throw new ApiError(400, '계좌를 선택하세요');
  const tx = {
    date: parseDate(body.date), type, amount, account_id: accountId,
    memo: String(body.memo ?? '').trim(), category_id: null, to_account_id: null,
  };
  if (type === '이체') {
    const toId = resolveRef(data.accounts, body, 'to_account_id', 'to_account', '입금 계좌');
    if (toId === null) throw new ApiError(400, '이체는 입금 계좌가 필요합니다');
    if (toId === accountId) throw new ApiError(400, '출금 계좌와 입금 계좌가 같습니다');
    tx.to_account_id = toId;
  } else {
    const catId = resolveRef(data.categories, body, 'category_id', 'category', '카테고리', c => c.type === type);
    if (catId === null) throw new ApiError(400, '카테고리를 선택하세요');
    tx.category_id = catId;
  }
  return tx;
}

// 같은 날짜·구분·금액·메모의 거래 (사용자에게 확인받을 대상)
function findDuplicates(data, tx, excludeId = null) {
  return data.transactions
    .filter(t => t.date === tx.date && t.type === tx.type && t.amount === tx.amount &&
                 t.memo === tx.memo && t.id !== excludeId)
    .map(t => txView(data, t));
}

function insertTx(data, tx, source, key = null) {
  const stamp = nowIso();
  const row = { id: data.next_id.transaction++, ...tx, source, hash: key, created_at: stamp, updated_at: stamp };
  data.transactions.push(row);
  return row;
}

function createTransaction(data, body) {
  const tx = normalizeTransaction(data, body);
  const source = body.source || 'web';
  if (!TX_SOURCES.includes(source)) throw new ApiError(400, 'source는 web 또는 excel이어야 합니다');
  if (!body.force) {
    const duplicates = findDuplicates(data, tx);
    if (duplicates.length) {
      throw new ApiError(409, '같은 날짜·구분·금액·메모의 거래가 이미 있습니다', { code: 'duplicate', duplicates });
    }
  }
  return txView(data, insertTx(data, tx, source));
}

function updateTransaction(data, id, body) {
  const current = getTx(data, id);
  const merged = { date: current.date, type: current.type, amount: current.amount, memo: current.memo };
  // 이름 대신 id를 기본값으로 쓰되, 본문에 이름이 오면 이름을 우선한다
  for (const [idKey, nameKey] of [['account_id', 'account'], ['to_account_id', 'to_account'], ['category_id', 'category']]) {
    if (nameKey in body || idKey in body) {
      merged[idKey] = body[idKey];
      merged[nameKey] = body[nameKey];
    } else {
      merged[idKey] = current[idKey];
    }
  }
  for (const k of ['date', 'type', 'amount', 'memo']) if (k in body) merged[k] = body[k];
  Object.assign(current, normalizeTransaction(data, merged), { updated_at: nowIso() });
  return txView(data, current);
}

function deleteTransaction(data, id) {
  getTx(data, id);
  data.transactions = data.transactions.filter(t => t.id !== id);
  return { ok: true };
}

// ---------------------------------------------------------------- 계좌·카테고리·예산

function findById(list, id, label) {
  const item = list.find(x => x.id === id);
  if (!item) throw new ApiError(404, `${label}을(를) 찾을 수 없습니다`);
  return item;
}

function saveAccount(data, body, id = null) {
  const current = id ? findById(data.accounts, id, '계좌') : { opening_balance: 0 };
  const merged = { ...current };
  for (const k of ['name', 'kind', 'opening_balance']) if (k in body) merged[k] = body[k];
  const name = String(merged.name ?? '').trim();
  if (!name) throw new ApiError(400, '계좌 이름을 입력하세요');
  if (!ACCOUNT_KINDS.includes(merged.kind)) throw new ApiError(400, '종류는 현금, 계좌, 카드 중 하나여야 합니다');
  const opening = parseInt_(merged.opening_balance ?? 0, '시작 잔액');
  if (data.accounts.some(a => a.name === name && a.id !== id)) throw new ApiError(409, `같은 이름의 계좌가 있습니다: ${name}`);
  if (id) {
    Object.assign(current, { name, kind: merged.kind, opening_balance: opening });
    return { ...current };
  }
  const account = { id: data.next_id.account++, name, kind: merged.kind, opening_balance: opening };
  data.accounts.push(account);
  return { ...account };
}

function saveCategory(data, body, id = null) {
  const current = id ? findById(data.categories, id, '카테고리') : {};
  const merged = { ...current };
  for (const k of ['name', 'type']) if (k in body) merged[k] = body[k];
  const name = String(merged.name ?? '').trim();
  if (!name) throw new ApiError(400, '카테고리 이름을 입력하세요');
  if (!CATEGORY_TYPES.includes(merged.type)) throw new ApiError(400, '카테고리 구분은 수입 또는 지출이어야 합니다');
  if (id && merged.type !== current.type && data.transactions.some(t => t.category_id === id)) {
    throw new ApiError(409, '거래가 있는 카테고리는 수입/지출 구분을 바꿀 수 없습니다');
  }
  if (data.categories.some(c => c.name === name && c.type === merged.type && c.id !== id)) {
    throw new ApiError(409, `같은 이름의 카테고리가 있습니다: ${name}`);
  }
  if (id) {
    Object.assign(current, { name, type: merged.type });
    return { ...current };
  }
  const category = { id: data.next_id.category++, name, type: merged.type };
  data.categories.push(category);
  return { ...category };
}

function deleteAccount(data, id) {
  findById(data.accounts, id, '계좌');
  if (data.transactions.some(t => t.account_id === id || t.to_account_id === id)) {
    throw new ApiError(409, '거래가 있는 계좌은(는) 삭제할 수 없습니다');
  }
  data.accounts = data.accounts.filter(a => a.id !== id);
  return { ok: true };
}

function deleteCategory(data, id) {
  findById(data.categories, id, '카테고리');
  if (data.transactions.some(t => t.category_id === id)) {
    throw new ApiError(409, '거래가 있는 카테고리은(는) 삭제할 수 없습니다');
  }
  data.categories = data.categories.filter(c => c.id !== id);
  data.budgets = data.budgets.filter(b => b.category_id !== id);  // 서버판의 ON DELETE CASCADE
  return { ok: true };
}

function budgetView(data, b) {
  return { category_id: b.category_id, category: data.categories.find(c => c.id === b.category_id)?.name,
           month: b.month, amount: b.amount };
}

function listBudgets(data, query) {
  let list = data.budgets;
  if (query.month) {
    const month = parseMonth(query.month);
    list = list.filter(b => b.month === month);
  }
  return list.map(b => budgetView(data, b))
    .sort((a, b) => (query.month ? 0 : a.month.localeCompare(b.month)) || a.category.localeCompare(b.category));
}

function saveBudget(data, body) {
  const categoryId = resolveRef(data.categories, body, 'category_id', 'category', '카테고리', c => c.type === '지출');
  if (categoryId === null) throw new ApiError(400, '지출 카테고리를 선택하세요');
  const month = parseMonth(body.month);
  const amount = parseInt_(body.amount, '예산');
  if (amount < 0) throw new ApiError(400, '예산은 0 이상이어야 합니다');
  let budget = data.budgets.find(b => b.category_id === categoryId && b.month === month);
  if (budget) budget.amount = amount;
  else data.budgets.push(budget = { category_id: categoryId, month, amount });
  return budgetView(data, budget);
}

function deleteBudget(data, categoryId, month) {
  parseMonth(month);
  const before = data.budgets.length;
  data.budgets = data.budgets.filter(b => !(b.category_id === categoryId && b.month === month));
  if (data.budgets.length === before) throw new ApiError(404, '예산을 찾을 수 없습니다');
  return { ok: true };
}

// ---------------------------------------------------------------- 요약

// 계좌 잔액 = 시작 잔액 + 수입 − 지출 − 이체출금 + 이체입금. beforeDate 미만 거래만 반영.
function accountBalances(data, beforeDate = null) {
  const balance = new Map(data.accounts.map(a => [a.id, a.opening_balance]));
  for (const t of data.transactions) {
    if (beforeDate && t.date >= beforeDate) continue;
    balance.set(t.account_id, balance.get(t.account_id) + (t.type === '수입' ? t.amount : -t.amount));
    if (t.type === '이체') balance.set(t.to_account_id, balance.get(t.to_account_id) + t.amount);
  }
  return [...data.accounts].sort((a, b) => a.id - b.id)
    .map(a => ({ id: a.id, name: a.name, kind: a.kind, balance: balance.get(a.id) }));
}

// {월: {income, expense}} — 이체는 제외
function monthlyTotals(data, first, last) {
  const totals = {};
  for (let m = first; m <= last; m = monthAdd(m, 1)) totals[m] = { income: 0, expense: 0 };
  for (const t of data.transactions) {
    const m = t.date.slice(0, 7);
    if (t.type === '이체' || !totals[m]) continue;
    totals[m][t.type === '수입' ? 'income' : 'expense'] += t.amount;
  }
  return totals;
}

function categorySpending(data, month) {
  const sums = new Map();
  for (const t of data.transactions) {
    if (t.type !== '지출' || t.date.slice(0, 7) !== month) continue;
    sums.set(t.category_id, (sums.get(t.category_id) || 0) + t.amount);
  }
  return [...sums].map(([id, amount]) => ({
    category_id: id, category: data.categories.find(c => c.id === id)?.name ?? '미분류', amount,
  })).sort((a, b) => b.amount - a.amount);
}

function summary(data, month) {
  month = parseMonth(month);
  const totals = monthlyTotals(data, monthAdd(month, -11), month);
  const spending = categorySpending(data, month);
  const spent = new Map(spending.map(s => [s.category_id, s.amount]));
  const budgets = listBudgets(data, { month }).map(b => ({
    category_id: b.category_id, category: b.category, budget: b.amount,
    spent: spent.get(b.category_id) || 0, remaining: b.amount - (spent.get(b.category_id) || 0),
  }));
  const thisMonth = totals[month];
  return {
    month, income: thisMonth.income, expense: thisMonth.expense, net: thisMonth.income - thisMonth.expense,
    categories: spending, budgets, accounts: accountBalances(data, monthEnd(month)),
    trend: Object.entries(totals).map(([m, t]) => ({ month: m, income: t.income, expense: t.expense, net: t.income - t.expense })),
  };
}

// ---------------------------------------------------------------- CSV

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(header, rows) {
  return '﻿' + [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function exportTransactionsCsv(data) {
  const rows = [...data.transactions].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id)
    .map(t => txView(data, t))
    .map(t => [t.id, t.date, t.date.slice(0, 7), t.type, t.category || '', t.amount, t.account,
               t.to_account || '', t.memo, t.source]);
  return toCsv(['ID', '날짜', '월', '구분', '카테고리', '금액', '계좌', '입금계좌', '메모', '출처'], rows);
}

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function importDate(text) {
  const m = String(text || '').trim().match(/^(\d{4})[-./]?(\d{1,2})[-./]?(\d{1,2})/);
  const date = m && isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  if (!date) throw new Error(`날짜를 읽을 수 없습니다: ${text}`);
  return date;
}

function importAmount(text) {
  const t = String(text || '').replace(/[,원 ]/g, '').trim();
  if (t === '' || t === '-') return 0;
  if (!/^[-+]?\d+(\.0+)?$/.test(t)) throw new Error(`금액을 읽을 수 없습니다: ${t}`);
  return Math.trunc(Number(t));
}

// 가져오기 중복 키 (서버판의 hash와 같은 역할, 개인 데이터 저장소 안에서만 쓰므로 원문 그대로 둔다)
function importKey(date, signed, accountId, memo) { return `csv|${date}|${signed}|${accountId}|${memo}`; }

function importCsv(data, body) {
  const text = body.csv;
  if (typeof text !== 'string' || !text.trim()) throw new ApiError(400, 'CSV 내용이 비어 있습니다');
  const mapping = body.mapping || {};
  const accountId = resolveRef(data.accounts, body, 'account_id', 'account', '계좌');
  if (accountId === null) throw new ApiError(400, '가져올 계좌를 선택하세요');
  if (!mapping.date) throw new ApiError(400, '날짜 열을 지정하세요');
  if (!mapping.amount && !(mapping.withdraw || mapping.deposit)) throw new ApiError(400, '금액 열(또는 출금/입금 열)을 지정하세요');

  const rows = parseCsv(text.replace(/^﻿/, '')).slice(Number(body.skip_rows) || 0);
  const header = (rows.shift() || []).map(h => h.trim());
  const memoCols = [].concat(mapping.memo || []);
  const needed = ['date', 'amount', 'withdraw', 'deposit', 'type', 'category'].filter(k => mapping[k]).map(k => mapping[k])
    .concat(memoCols);
  const missing = needed.filter(c => !header.includes(c));
  if (missing.length) throw new ApiError(400, `CSV에 없는 열: ${missing.join(', ')}`, { header });
  const cell = (row, name) => (row[header.indexOf(name)] ?? '').trim();
  const keys = new Set(data.transactions.map(t => t.hash).filter(Boolean));

  let added = 0, skipped = 0;
  const errors = [];
  rows.forEach((row, i) => {
    if (!row.some(c => c.trim())) return;
    let tx, key;
    try {
      const date = importDate(cell(row, mapping.date));
      let signed = mapping.amount ? importAmount(cell(row, mapping.amount))
        : (mapping.deposit ? importAmount(cell(row, mapping.deposit)) : 0) -
          (mapping.withdraw ? importAmount(cell(row, mapping.withdraw)) : 0);
      let type = mapping.type ? cell(row, mapping.type) : '';
      if (!CATEGORY_TYPES.includes(type)) type = signed > 0 ? '수입' : '지출';
      const amount = Math.abs(signed);
      if (amount === 0) throw new Error('금액이 0입니다');
      signed = type === '지출' ? -amount : amount;
      const memo = memoCols.map(c => cell(row, c)).filter(Boolean).join(' ');
      const category = mapping.category
        ? data.categories.find(c => c.name === cell(row, mapping.category) && c.type === type) : null;
      tx = { date, type, amount, account_id: accountId, memo, category_id: category?.id ?? null, to_account_id: null };
      key = importKey(date, signed, accountId, memo);
    } catch (e) {
      errors.push({ line: i + 2, error: e.message });
      return;
    }
    if (keys.has(key)) { skipped++; return; }
    keys.add(key);
    insertTx(data, tx, 'import', key);
    added++;
  });
  return { added, skipped, errors };
}

// ---------------------------------------------------------------- 사진 가져오기 (은행 앱 캡처)

const OCR_DATE = /(\d{1,2})\s*월\s*(\d{1,2})\s*일(?:.*?(\d{1,2}:\d{2}(?::\d{2})?))?/;
const OCR_AMOUNT = /^([+\-−–])?(\d{1,3}(?:,\d{3})+|\d+)원$/;
const OCR_BALANCE = /잔액\s*(\d{1,3}(?:,\d{3})+|\d+)\s*원/;
// '10.17 (토)'. OCR이 요일을 못 읽어 '10.01 ()'이 되어도 받는다.
const OCR_DAY_HEADER = /^(\d{1,2})\s*\.\s*(\d{1,2})\s*\(.{0,2}\)$/;
const OCR_CLOCK = /^(\d{1,2}):?(\d{2})(?!\d)/;

const amountMatch = text => text.replace(/\s/g, '').match(OCR_AMOUNT);
const toNumber = text => Number(text.replace(/,/g, ''));

function statementEndDate(lines) {
  for (const line of lines) {
    if (!line.text.includes('~')) continue;
    const digits = line.text.split('~')[1].replace(/\D/g, '');
    if (digits.length >= 8) {
      const date = isoDate(Number(digits.slice(0, 4)), Number(digits.slice(4, 6)), Number(digits.slice(6, 8)));
      if (date) return date;
    }
  }
  return null;
}

function statementYear(mon, end) {
  const y = Number(end.slice(0, 4));
  return mon <= Number(end.slice(5, 7)) ? y : y - 1;
}

// 한자가 섞이거나 비어 있으면 OCR이 가게 이름을 잘못 읽었을 가능성이 크다
function memoSuspect(memo) { return !memo || /[一-鿿]/.test(memo); }

const sortLines = ocr => [...(ocr.lines || [])].sort((a, b) => a.y - b.y || a.x - b.x);

// 거래내역 캡처의 OCR 결과를 거래 후보 목록(화면 순서, 최신 먼저)으로 바꾼다.
// '10.17 (토)' 같은 날짜 묶음 제목이 있으면 이용내역(상품권·페이) 화면, 아니면 은행 앱 화면.
export function parseStatement(ocr, today = todayIso()) {
  const lines = sortLines(ocr);
  if (lines.some(l => OCR_DAY_HEADER.test(l.text.trim()))) return parseUsageList(ocr, today);
  return parseBankStatement(ocr, today);
}

// 이용내역 화면: '10.17 (토)' 제목 아래 거래들. 거래 하나는 오른쪽 금액 줄('-72,000 원')에서 시작하고,
// 왼쪽에 종류('결제'·'충전'), 가게 이름, '16:35 본인신청…' 시각 줄이 차례로 온다. 잔액은 없다.
function parseUsageList(ocr, today) {
  const lines = sortLines(ocr);
  const width = ocr.width || Math.max(1, ...lines.map(l => l.x + l.w));
  const headers = [], amounts = [], left = [];
  for (const line of lines) {
    const text = line.text.trim();
    const head = text.match(OCR_DAY_HEADER);
    const amount = amountMatch(text);
    if (head) headers.push({ y: line.y, mon: Number(head[1]), day: Number(head[2]) });
    else if (amount && line.x >= width * 0.55) amounts.push({ line, amount });
    else if (line.x < width * 0.55) left.push(line);
  }
  fixHeaderDates(headers, today);
  return amounts.map(({ line, amount }, i) => {
    const top = line.y - Math.floor(line.h / 2);
    const next = amounts[i + 1]?.line;
    const bottom = Math.min(next ? next.y - Math.floor(next.h / 2) : Infinity,
      ...headers.filter(h => h.y > line.y).map(h => h.y));
    const head = headers.filter(h => h.y < line.y).pop();
    const date = head?.date ?? null;
    const texts = left.filter(l => l.y >= top && l.y < bottom).map(l => l.text.trim());
    const kind = texts.shift() || '';
    let time = '';
    const memoParts = [];
    for (const text of texts) {
      const clock = text.match(OCR_CLOCK);
      if (clock) {
        time = `${pad(Number(clock[1]))}:${clock[2]}`;
        break;  // 시각 줄이 거래의 마지막 줄 (그 아래는 잘린 다음 거래일 수 있음)
      }
      memoParts.push(text);
    }
    let memo = memoParts.join(' ');
    if (kind && !kind.includes('결제')) memo = `${kind} ${memo}`.trim();  // '선할인(충전) 정읍사랑상품권'처럼 종류를 남긴다
    const sign = amount[1];
    const row = { date, time, memo, amount: toNumber(amount[2]), balance: null,
                  type: sign && sign !== '+' ? '지출' : '수입' };
    if (!date || !row.amount) Object.assign(row, { status: 'warn', note: '금액이나 날짜를 읽지 못했습니다' });
    else if (kind.includes('충전') && !kind.includes('할인')) {
      Object.assign(row, { status: 'warn', note: '충전은 체크를 꺼 두었습니다 (은행에서 옮긴 돈이면 입력 폼에서 이체로)' });
    } else {
      row.status = 'ok';
      row.note = [head.guessed ? `날짜 제목을 '${head.guessed}'로 읽어 고쳤습니다. 날짜를 확인하세요` : '',
                  memoSuspect(memo) ? '메모 글자를 확인하세요' : ''].filter(Boolean).join(' · ');
    }
    return row;
  });
}

// 날짜 제목은 최신순. '10.14'를 '10.74'처럼 1을 7로 잘못 읽어 없는 날짜가 되면,
// 7→1로 바꿔 보고 앞뒤 제목 날짜 사이에 들어갈 때만 그 날짜로 쓴다.
function fixHeaderDates(headers, today) {
  const dateOf = (mon, day) => isoDate(statementYear(mon, today), mon, day);
  for (const h of headers) h.date = dateOf(h.mon, h.day);
  headers.forEach((h, i) => {
    if (h.date) return;
    const newer = headers.slice(0, i).reverse().find(x => x.date)?.date ?? today;
    const older = headers.slice(i + 1).find(x => x.date)?.date ?? '0000-00-00';
    const text = `${h.mon}.${h.day}`;
    const fixed = text.replace(/7/g, '1');
    if (fixed === text) return;
    const [mon, day] = fixed.split('.').map(Number);
    const date = dateOf(mon, day);
    if (date && date <= newer && date >= older) Object.assign(h, { date, guessed: text });
  });
}

// 은행 앱 거래내역 화면. 한 거래 = '10월 18일 · 22:42:50' 줄로 시작해 다음 날짜 줄 전까지.
// 그 안에서 왼쪽 글자는 메모, '-7,890원'은 금액, '잔액 413,397원'은 거래 후 잔액.
function parseBankStatement(ocr, today) {
  const lines = sortLines(ocr);
  const width = ocr.width || Math.max(1, ...lines.map(l => l.x + l.w));
  const end = statementEndDate(lines) || today;
  const blocks = [];
  for (const line of lines) {
    const text = line.text.trim();
    const match = text.match(OCR_DATE);
    // '10월 5일 회식' 같은 메모와 구분: 시각이 있거나 날짜만 있는 줄
    if (match && (match[3] || /^\d{1,2}\s*월\s*\d{1,2}\s*일$/.test(text))) blocks.push({ match, lines: [] });
    else if (blocks.length) blocks[blocks.length - 1].lines.push(line);
  }
  const rows = blocks.map(({ match, lines: blockLines }) => {
    const mon = Number(match[1]), day = Number(match[2]);
    const row = { date: isoDate(statementYear(mon, end), mon, day), time: match[3] || '', memo: '',
                  amount: null, sign: null, balance: null };
    const memo = [];
    for (const line of blockLines) {
      const text = line.text.trim();
      const balance = text.match(OCR_BALANCE);
      const amount = amountMatch(text);
      if (balance) { if (row.balance === null) row.balance = toNumber(balance[1]); }
      else if (amount) {
        if (row.amount === null) {
          row.amount = toNumber(amount[2]);
          row.sign = amount[1] === '+' ? '+' : amount[1] ? '-' : null;
        }
      } else if (line.x < width * 0.55) memo.push(text);
    }
    row.memo = memo.join(' ');
    return row;
  });

  // 잔액 검산: (이 거래 후 잔액) − (바로 이전 거래 후 잔액) = 이 거래의 증감
  rows.forEach((row, i) => {
    const older = rows[i + 1];
    const diff = row.balance !== null && older && older.balance !== null ? row.balance - older.balance : null;
    let verified = null;
    if (row.amount !== null && diff !== null) {
      if (row.sign === null && Math.abs(diff) === row.amount) row.sign = diff > 0 ? '+' : '-';
      verified = diff === (row.sign === '+' ? row.amount : -row.amount);
    }
    row.type = row.sign === '+' ? '수입' : '지출';
    if (!row.date || !row.amount) Object.assign(row, { status: 'warn', note: '금액이나 날짜를 읽지 못했습니다' });
    else if (verified === false) Object.assign(row, { status: 'warn', note: '잔액 검산이 맞지 않습니다' });
    else if (row.sign === null) Object.assign(row, { status: 'warn', note: '입금/출금을 알 수 없어 지출로 두었습니다' });
    else {
      row.status = 'ok';
      row.note = [verified ? '잔액 검산 일치' : '', memoSuspect(row.memo) ? '메모 글자를 확인하세요' : '']
        .filter(Boolean).join(' · ');
    }
    delete row.sign;
  });
  return rows;
}

// 사진 가져오기 중복 키. 메모는 OCR 오차가 있으니 거래 후 잔액, 없으면 거래 시각을 쓴다.
function imageKey(date, signed, accountId, balance, memo, time = '') {
  if (balance !== null && balance !== undefined) return `img|${date}|${signed}|${accountId}|${balance}`;
  if (time) return `img|${date}|${signed}|${accountId}|t${time}`;
  return importKey(date, signed, accountId, memo);
}

// OCR 결과(브라우저에서 읽은 것)를 미리보기 행으로 바꾼다. 데이터는 바꾸지 않는다.
function previewImage(data, body) {
  const accountId = resolveRef(data.accounts, body, 'account_id', 'account', '계좌');
  if (accountId === null) throw new ApiError(400, '가져올 계좌를 선택하세요');
  if (!body.ocr || !Array.isArray(body.ocr.lines)) throw new ApiError(400, '사진을 읽은 결과가 없습니다');
  const keys = new Set(data.transactions.map(t => t.hash).filter(Boolean));
  const rows = parseStatement(body.ocr, body.today || todayIso());
  for (const row of rows) {
    row.category_id = null;
    if (!row.date || !row.amount) continue;
    const signed = row.type === '수입' ? row.amount : -row.amount;
    if (keys.has(imageKey(row.date, signed, accountId, row.balance, row.memo, row.time))) {
      Object.assign(row, { status: 'duplicate', note: '이미 가져온 거래입니다' });
    } else {
      const same = data.transactions.find(t => t.account_id === accountId && t.date === row.date &&
                                               t.type === row.type && t.amount === row.amount);
      if (same) Object.assign(row, { status: 'duplicate', note: `같은 날 같은 금액 거래가 있습니다 (${same.memo || '메모 없음'}, ${same.source})` });
    }
    // 같은 메모로 전에 고른 카테고리를 추천한다
    const prev = [...data.transactions].reverse()
      .find(t => t.memo === row.memo && t.type === row.type && t.category_id !== null);
    if (prev) row.category_id = prev.category_id;
  }
  return { rows };
}

// 미리보기에서 고른 행을 저장한다. force는 중복 표시를 사용자가 직접 체크한 행.
function importRows(data, body) {
  const accountId = resolveRef(data.accounts, body, 'account_id', 'account', '계좌');
  if (accountId === null) throw new ApiError(400, '가져올 계좌를 선택하세요');
  if (!Array.isArray(body.rows) || !body.rows.length) throw new ApiError(400, '저장할 행이 없습니다');
  const keys = new Set(data.transactions.map(t => t.hash).filter(Boolean));
  let added = 0, skipped = 0;
  const errors = [];
  body.rows.forEach((row, i) => {
    let tx, key;
    try {
      if (!row || typeof row !== 'object') throw new ApiError(400, '행 형식이 잘못되었습니다');
      const date = parseDate(row.date);
      if (!CATEGORY_TYPES.includes(row.type)) throw new ApiError(400, '구분은 수입 또는 지출이어야 합니다');
      const amount = parseInt_(row.amount, '금액');
      if (amount <= 0) throw new ApiError(400, '금액은 0보다 커야 합니다');
      const categoryId = resolveRef(data.categories, row, 'category_id', 'category', '카테고리', c => c.type === row.type);
      const balance = row.balance === null || row.balance === undefined || row.balance === '' ? null : parseInt_(row.balance, '잔액');
      const time = String(row.time || '').trim();
      if (time && !/^\d{2}:\d{2}(:\d{2})?$/.test(time)) throw new ApiError(400, '시각 형식이 잘못되었습니다');
      const memo = String(row.memo || '').trim();
      tx = { date, type: row.type, amount, account_id: accountId, memo, category_id: categoryId, to_account_id: null };
      key = imageKey(date, row.type === '수입' ? amount : -amount, accountId, balance, memo, time);
    } catch (e) {
      errors.push({ row: i + 1, error: e.message });
      return;
    }
    if (keys.has(key)) {
      if (!row.force) { skipped++; return; }
      key = null;  // 사용자가 중복을 알고 저장 → 키 없이 넣는다
    }
    if (key) keys.add(key);
    insertTx(data, tx, 'import', key);
    added++;
  });
  return { added, skipped, errors };
}

// ---------------------------------------------------------------- 라우팅

const ROUTES = [
  // [method, 경로 정규식, 처리 함수(data, match, query, body), 쓰기 여부, 커밋 메시지]
  ['GET', /^\/api\/transactions$/, (d, m, q) => listTransactions(d, q)],
  ['POST', /^\/api\/transactions$/, (d, m, q, b) => createTransaction(d, b), '거래 추가'],
  ['GET', /^\/api\/transactions\/(\d+)$/, (d, m) => txView(d, getTx(d, Number(m[1])))],
  ['PUT', /^\/api\/transactions\/(\d+)$/, (d, m, q, b) => updateTransaction(d, Number(m[1]), b), '거래 수정'],
  ['DELETE', /^\/api\/transactions\/(\d+)$/, (d, m) => deleteTransaction(d, Number(m[1])), '거래 삭제'],
  ['GET', /^\/api\/accounts$/, d => [...d.accounts].sort((a, b) => a.id - b.id).map(a => ({ ...a }))],
  ['POST', /^\/api\/accounts$/, (d, m, q, b) => saveAccount(d, b), '계좌 추가'],
  ['PUT', /^\/api\/accounts\/(\d+)$/, (d, m, q, b) => saveAccount(d, b, Number(m[1])), '계좌 수정'],
  ['DELETE', /^\/api\/accounts\/(\d+)$/, (d, m) => deleteAccount(d, Number(m[1])), '계좌 삭제'],
  ['GET', /^\/api\/categories$/, d => [...d.categories].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)).map(c => ({ ...c }))],
  ['POST', /^\/api\/categories$/, (d, m, q, b) => saveCategory(d, b), '카테고리 추가'],
  ['PUT', /^\/api\/categories\/(\d+)$/, (d, m, q, b) => saveCategory(d, b, Number(m[1])), '카테고리 수정'],
  ['DELETE', /^\/api\/categories\/(\d+)$/, (d, m) => deleteCategory(d, Number(m[1])), '카테고리 삭제'],
  ['GET', /^\/api\/budgets$/, (d, m, q) => listBudgets(d, q)],
  ['POST', /^\/api\/budgets$/, (d, m, q, b) => saveBudget(d, b), '예산 저장'],
  ['DELETE', /^\/api\/budgets\/(\d+)\/(\d{4}-\d{2})$/, (d, m) => deleteBudget(d, Number(m[1]), m[2]), '예산 삭제'],
  ['GET', /^\/api\/summary$/, (d, m, q) => summary(d, q.month || todayIso().slice(0, 7))],
  ['POST', /^\/api\/import\/csv$/, (d, m, q, b) => importCsv(d, b), 'CSV 가져오기'],
  ['POST', /^\/api\/import\/image$/, (d, m, q, b) => previewImage(d, b)],
  ['POST', /^\/api\/import\/rows$/, (d, m, q, b) => importRows(d, b), '사진 가져오기'],
].map(([method, pattern, handler, message]) => ({ method, pattern, handler, message }));

export function normalizeData(raw) {
  const data = { ...emptyData(), ...(raw || {}) };
  data.next_id = { ...emptyData().next_id, ...(raw?.next_id || {}) };
  for (const [list, key] of [['accounts', 'account'], ['categories', 'category'], ['transactions', 'transaction']]) {
    const maxId = Math.max(0, ...data[list].map(x => x.id));
    if (data.next_id[key] <= maxId) data.next_id[key] = maxId + 1;
  }
  return data;
}

// store: { load() → {data, sha}, save(data, sha, message) → sha, changed(sha) → bool }
// 저장이 충돌하면(다른 기기가 먼저 저장) 최신 데이터를 다시 읽어 같은 요청을 다시 적용한다.
export class Ledger {
  constructor(store) {
    this.store = store;
    this.data = null;
    this.sha = null;
    this.queue = Promise.resolve();
  }

  async load() {
    const { data, sha } = await this.store.load();
    this.data = normalizeData(data);
    this.sha = sha;
  }

  // 다른 기기에서 바뀌었으면 다시 읽고 true
  async refresh() {
    if (this.data && !(await this.store.changed(this.sha))) return false;
    await this.load();
    return true;
  }

  request(method, path, body = {}) {
    const url = new URL(path, 'http://local');
    const query = Object.fromEntries(url.searchParams);
    const route = ROUTES.find(r => r.method === method && r.pattern.test(url.pathname));
    if (!route) return Promise.reject(new ApiError(404, '없는 요청입니다'));
    const match = url.pathname.match(route.pattern);
    if (!route.message) {
      return this.queue.then(async () => {
        if (!this.data) await this.load();
        return clone(route.handler(this.data, match, query, body ?? {}));
      });
    }
    const run = this.queue.then(() => this.write(route, match, query, body ?? {}));
    this.queue = run.catch(() => {});
    return run;
  }

  async write(route, match, query, body) {
    for (let attempt = 0; ; attempt++) {
      if (!this.data) await this.load();
      const draft = clone(this.data);
      const before = JSON.stringify(draft);
      const result = route.handler(draft, match, query, body);
      if (JSON.stringify(draft) === before) return clone(result);  // 바뀐 것이 없으면 저장하지 않는다
      try {
        this.sha = await this.store.save(draft, this.sha, `웹: ${route.message}`);
        this.data = draft;
        return clone(result);
      } catch (e) {
        if (!e.conflict || attempt >= 2) throw e;
        await this.load();
      }
    }
  }

  exportCsv() { return exportTransactionsCsv(this.data); }
  exportJson() { return JSON.stringify(this.data, null, 1); }
}
