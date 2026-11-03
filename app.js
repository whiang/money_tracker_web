// 웹판(GitHub Pages): 서버판 static/app.js와 같은 화면. 데이터는 ledger.js가 브라우저 안에서 처리하고
// store.js가 비공개 GitHub 저장소의 JSON에 저장한다.
import { Ledger } from './ledger.js';
import { GitHubStore } from './store.js';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

// 범주형 색 순서 (고정 순서, 8번째는 '기타' 회색)
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6'];
const OTHER_COLOR = '#b5b3ad';
const POLL_MS = 30000;
const CONFIG_KEY = 'ledgerGitHub';

let ledger = null;

const state = {
  tab: 'input',
  accounts: [],
  categories: [],
  listMonth: thisMonth(),
  summaryMonth: thisMonth(),
  budgetMonth: thisMonth(),
  editing: null,      // 수정 중인 거래
  charts: {},
  importText: '',
  summaries: {},      // 월별 요약 캐시, 데이터가 바뀌면 비운다
};

// ---------------------------------------------------------------- 유틸

function pad(n) { return String(n).padStart(2, '0'); }
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function thisMonth() { return today().slice(0, 7); }
function addMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const i = y * 12 + (m - 1) + delta;
  return `${Math.floor(i / 12)}-${pad(i % 12 + 1)}`;
}
function monthLabel(month) {
  const [y, m] = month.split('-');
  return `${y}년 ${Number(m)}월`;
}
function won(n) {
  return (n < 0 ? '−' : '') + Math.abs(n).toLocaleString('ko-KR') + '원';
}
function digits(text) { return String(text || '').replace(/[^\d-]/g, ''); }
function formatAmountInput(input) {
  const raw = String(input.value).replace(/[^\d]/g, '');
  input.value = raw ? Number(raw).toLocaleString('ko-KR') : '';
}
function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
function dayLabel(date) {
  const d = new Date(date + 'T00:00:00');
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[d.getDay()]})`;
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

function storageGet(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 저장 불가 시 무시 */ }
}

// ---------------------------------------------------------------- API

// 서버판과 같은 호출 모양. 오류는 {status, message, data}로 던진다.
async function api(method, path, body) {
  if (!ledger) throw Object.assign(new Error('로그인이 필요합니다'), { status: 401 });
  try {
    return await ledger.request(method, path, body);
  } catch (err) {
    if (err.status === 401) showLogin(err.message);
    throw err;
  }
}

function report(err) {
  if (err.status !== 401) toast(err.message);
}

// ---------------------------------------------------------------- 로그인 (GitHub 토큰)

function showLogin(message = '') {
  $('#login').hidden = false;
  $('#app').hidden = true;
  $('#tabbar').hidden = true;
  $('#login-error').textContent = message;
  const config = storageGet(CONFIG_KEY);
  if (config?.repo) $('#login-repo').value = config.repo;
  $('#login-token').focus();
}

function connect(config) {
  ledger = new Ledger(new GitHubStore(config));
}

async function start() {
  await ledger.load();
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#tabbar').hidden = false;
  await reloadAll();
}

$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  $('#login-error').textContent = '';
  const config = { repo: $('#login-repo').value.trim(), token: $('#login-token').value.trim() };
  if (!/^[\w.-]+\/[\w.-]+$/.test(config.repo)) {
    $('#login-error').textContent = '저장소는 owner/name 형식으로 적으세요';
    return;
  }
  connect(config);
  try {
    await start();
    storageSet(CONFIG_KEY, config);  // 확인된 토큰만 이 기기에 저장한다
    $('#login-token').value = '';
  } catch (err) {
    ledger = null;
    $('#login-error').textContent = err.message;
  }
});

$('#logout').addEventListener('click', () => {
  if (!confirm('이 기기에 저장된 GitHub 토큰을 지우고 로그아웃할까요?')) return;
  const config = storageGet(CONFIG_KEY);
  storageSet(CONFIG_KEY, config ? { repo: config.repo } : null);
  ledger = null;
  showLogin();
});

// ---------------------------------------------------------------- 탭·갱신

function showTab(tab) {
  state.tab = tab;
  $$('.tab').forEach(s => { s.hidden = s.id !== `tab-${tab}`; });
  $$('#tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  window.scrollTo(0, 0);
  renderTab().catch(report);
}

$$('#tabbar button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

async function loadRefs() {
  const [accounts, categories] = await Promise.all([
    api('GET', '/api/accounts'), api('GET', '/api/categories')]);
  state.accounts = accounts;
  state.categories = categories;
  fillTxSelects();
  fillFilterSelects();
  fillSelect($('#imp-account'), accounts.map(a => [a.id, a.name]));
  fillSelect($('#img-account'), accounts.map(a => [a.id, a.name]), '계좌 선택');
  const lastImgAccount = storageGet('imgAccount');
  if (!$('#img-account').value && lastImgAccount && accounts.some(a => a.id === lastImgAccount)) {
    $('#img-account').value = lastImgAccount;
  }
}

async function renderTab() {
  if (state.tab === 'input') return renderList();
  if (state.tab === 'summary') return renderSummary();
  if (state.tab === 'settings') return renderSettings();
}

// 데이터는 이미 이 브라우저 메모리에 있으므로 다시 그리기만 한다 (네트워크 요청 없음)
async function reloadAll() {
  state.summaries = {};
  await loadRefs();
  await renderTab();
  updateBudgetHint();
  showDataInfo();
}

function getSummary(month) {
  if (!state.summaries[month]) {
    state.summaries[month] = api('GET', `/api/summary?month=${month}`)
      .catch(err => { delete state.summaries[month]; throw err; });
  }
  return state.summaries[month];
}

// 30초마다, 그리고 화면에 다시 돌아올 때 다른 기기에서 바뀌었는지 확인한다
let checking = false;
async function checkVersion() {
  if (!ledger || checking || document.hidden || $('#app').hidden) return;
  checking = true;
  try {
    if (await ledger.refresh()) await reloadAll();
  } catch (err) {
    if (err.status === 401) showLogin(err.message);  // 토큰 만료 등. 일시적 연결 오류는 다음 확인 때 다시 시도
  } finally {
    checking = false;
  }
}
setInterval(checkVersion, POLL_MS);
document.addEventListener('visibilitychange', checkVersion);
window.addEventListener('focus', checkVersion);

// 월 이동 버튼 (내역·요약·예산 공통)
$$('.month-nav').forEach(nav => {
  const key = nav.dataset.monthKey;
  const move = delta => {
    state[key] = addMonth(state[key], delta);
    (key === 'budgetMonth' ? renderBudgets() : renderTab()).catch(report);
  };
  $('.nav-prev', nav).addEventListener('click', () => move(-1));
  $('.nav-next', nav).addEventListener('click', () => move(1));
});
function setMonthLabels() {
  $$('.month-nav').forEach(nav => {
    $('.month-label', nav).textContent = monthLabel(state[nav.dataset.monthKey]);
  });
}

function fillSelect(select, options, placeholder) {
  const keep = select.value;
  select.innerHTML = (placeholder !== undefined ? `<option value="">${esc(placeholder)}</option>` : '') +
    options.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join('');
  if ([...select.options].some(o => o.value === keep)) select.value = keep;
}

// ---------------------------------------------------------------- 입력

const form = $('#tx-form');
const txType = () => $('input[name=type]:checked', form).value;

function fillTxSelects() {
  const type = txType();
  const cats = state.categories.filter(c => c.type === (type === '수입' ? '수입' : '지출'));
  fillSelect($('#tx-category'), cats.map(c => [c.id, c.name]), '카테고리 선택');
  const accounts = state.accounts.map(a => [a.id, `${a.name} (${a.kind})`]);
  fillSelect($('#tx-account'), accounts, '계좌 선택');
  fillSelect($('#tx-to-account'), accounts, '계좌 선택');
}

function syncTypeFields() {
  const transfer = txType() === '이체';
  $('#tx-category-label').hidden = transfer;
  $('#tx-to-label').hidden = !transfer;
  $('#tx-account-caption').textContent = transfer ? '출금 계좌' : '계좌';
  fillTxSelects();
  updateBudgetHint();
}

$$('input[name=type]', form).forEach(r => r.addEventListener('change', syncTypeFields));
$('#tx-amount').addEventListener('input', e => { formatAmountInput(e.target); updateBudgetHint(); });
$('#tx-category').addEventListener('change', updateBudgetHint);
$('#tx-date').addEventListener('change', updateBudgetHint);

// 지출 카테고리를 고르면 그 달 남은 예산과 저장 후 남을 금액을 보여 준다
let hintSeq = 0;
async function updateBudgetHint() {
  const hint = $('#tx-budget-hint');
  const categoryId = Number($('#tx-category').value);
  const date = $('#tx-date').value;
  const seq = ++hintSeq;
  if (txType() !== '지출' || !categoryId || !date) { hint.hidden = true; return; }
  const month = date.slice(0, 7);
  let s;
  try { s = await getSummary(month); } catch { hint.hidden = true; return; }
  if (seq !== hintSeq) return;  // 그사이 입력이 바뀌었으면 버린다
  const b = s.budgets.find(x => x.category_id === categoryId);
  const monthName = `${Number(month.slice(5))}월`;
  if (!b) {
    hint.textContent = `${monthName}에 이 카테고리 예산이 없습니다`;
    hint.classList.remove('over');
    hint.hidden = false;
    return;
  }
  // 수정 중인 거래가 이미 사용액에 들어 있으면 빼고 계산한다
  const ed = state.editing;
  const already = ed && ed.type === '지출' && ed.category_id === categoryId && ed.date.slice(0, 7) === month ? ed.amount : 0;
  const remaining = b.remaining + already;
  const amount = Number(digits($('#tx-amount').value)) || 0;
  const after = remaining - amount;
  hint.textContent = `${b.category} ${monthName} 예산 ${won(b.budget)} · 남은 금액 ${won(remaining)}` +
    (amount ? ` → 저장 후 ${won(after)}` : '') + (after < 0 ? ' (초과)' : '');
  hint.classList.toggle('over', after < 0);
  hint.hidden = false;
}

function txBody() {
  const type = txType();
  const body = {
    date: $('#tx-date').value,
    type,
    amount: Number(digits($('#tx-amount').value)),
    account_id: Number($('#tx-account').value) || null,
    memo: $('#tx-memo').value.trim(),
  };
  if (type === '이체') body.to_account_id = Number($('#tx-to-account').value) || null;
  else body.category_id = Number($('#tx-category').value) || null;
  return body;
}

async function saveTx(force = false) {
  const body = txBody();
  if (!body.amount) return toast('금액을 입력하세요');
  try {
    if (state.editing) {
      await api('PUT', `/api/transactions/${state.editing.id}`, body);
      toast('수정했습니다');
      endEdit();
    } else {
      await api('POST', '/api/transactions', { ...body, source: 'web', force });
      toast(`저장했습니다 · ${won(body.amount)}`);
    }
    await reloadAll();
  } catch (err) {
    if (err.status === 409 && err.data?.code === 'duplicate') {
      const list = err.data.duplicates.map(d =>
        `· ${d.date} ${d.type} ${won(d.amount)} ${d.account}${d.memo ? ' / ' + d.memo : ''}`).join('\n');
      if (confirm(`같은 날짜·구분·금액·메모의 거래가 이미 있습니다.\n${list}\n\n그래도 저장할까요?`)) {
        return saveTx(true);
      }
      return;
    }
    report(err);
  }
}

form.addEventListener('submit', e => { e.preventDefault(); saveTx(); });

function startEdit(tx) {
  state.editing = tx;
  $$('.tx').forEach(li => li.classList.toggle('editing', Number(li.dataset.id) === tx.id));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  $('#input-title').textContent = '거래 수정';
  $(`input[name=type][value="${tx.type}"]`, form).checked = true;
  syncTypeFields();
  $('#tx-amount').value = tx.amount.toLocaleString('ko-KR');
  $('#tx-category').value = tx.category_id ?? '';
  $('#tx-account').value = tx.account_id;
  $('#tx-to-account').value = tx.to_account_id ?? '';
  $('#tx-date').value = tx.date;
  $('#tx-memo').value = tx.memo;
  $('#tx-submit').textContent = '수정 저장';
  $('#tx-cancel').hidden = false;
  $('#tx-delete').hidden = false;
  updateBudgetHint();
}

function endEdit() {
  state.editing = null;
  $$('.tx.editing').forEach(li => li.classList.remove('editing'));
  $('#input-title').textContent = '거래 입력';
  $('#tx-submit').textContent = '저장';
  $('#tx-cancel').hidden = true;
  $('#tx-delete').hidden = true;
  form.reset();
  $('#tx-date').value = today();
  syncTypeFields();
}

$('#tx-cancel').addEventListener('click', endEdit);
$('#tx-delete').addEventListener('click', async () => {
  const tx = state.editing;
  if (!confirm(`${tx.date} ${won(tx.amount)} ${tx.memo || ''} 거래를 삭제할까요?`)) return;
  try {
    await api('DELETE', `/api/transactions/${tx.id}`);
    toast('삭제했습니다');
    endEdit();
    await reloadAll();
  } catch (err) { report(err); }
});

// ---------------------------------------------------------------- 사진으로 입력

let imgRows = [];

// 글자 인식 모듈은 사진 입력을 처음 쓸 때만 불러온다 (평소 화면은 가볍게)
const loadOcr = () => import('./ocr.js');
const downloadNote = mb => `글자 인식 파일 받는 중… ${mb.toFixed(1)} / 약 33MB (처음 한 번만)`;

$('#img-account').addEventListener('change', e => storageSet('imgAccount', Number(e.target.value) || null));

$('#img-analyze').addEventListener('click', async () => {
  const files = [...$('#img-files').files];
  const accountId = Number($('#img-account').value);
  if (!accountId) return toast('계좌를 선택하세요');
  if (!files.length) return toast('캡처 사진을 고르세요');
  const status = $('#img-status');
  const button = $('#img-analyze');
  button.disabled = true;
  imgRows = [];
  const seen = new Set();
  try {
    const ocr = await loadOcr();
    for (let i = 0; i < files.length; i++) {
      status.textContent = `사진 ${i + 1}/${files.length} 분석 중…`;
      const lines = await ocr.recognize(files[i], mb => { status.textContent = downloadNote(mb); });
      const res = await api('POST', '/api/import/image', { ocr: lines, account_id: accountId, today: today() });
      for (const row of res.rows) {
        // 겹치게 찍은 사진의 같은 거래는 한 번만 저장 대상으로 둔다
        const key = [row.date, row.type, row.amount, row.balance ?? (row.time || row.memo)].join('|');
        if (row.amount && seen.has(key)) {
          row.status = 'duplicate';
          row.note = '다른 사진과 겹칩니다';
        }
        seen.add(key);
        row.checked = row.status === 'ok';
        row.photo = i + 1;
        imgRows.push(row);
      }
    }
    const counts = ['ok', 'warn', 'duplicate'].map(s => imgRows.filter(r => r.status === s).length);
    status.textContent = `${imgRows.length}건 읽음 · 확인됨 ${counts[0]} · 확인 필요 ${counts[1]} · 중복 ${counts[2]}. ` +
      '체크한 행만 저장합니다.';
  } catch (err) {
    status.textContent = err.message;
  } finally {
    button.disabled = false;
    renderImageRows();
  }
});

function renderImageRows() {
  $('#img-rows').innerHTML = imgRows.map((r, i) => {
    const cats = state.categories.filter(c => c.type === r.type);
    const badge = r.status === 'ok'
      ? `<span class="badge ok">${r.note.startsWith('잔액 검산 일치') ? '✓ 검산 일치' : '읽음'}</span>`
      : r.status === 'duplicate' ? '<span class="badge dup">중복</span>' : '<span class="badge warn">⚠ 확인 필요</span>';
    return `<div class="img-row ${r.status}${r.checked ? '' : ' off'}" data-i="${i}">
      <div class="img-head">
        <label><input type="checkbox" data-f="checked"${r.checked ? ' checked' : ''}> 저장</label>
        ${badge}<span class="time">사진 ${r.photo}${r.time ? ' · ' + esc(r.time) : ''}</span>
      </div>
      <div class="grid2">
        <input type="date" data-f="date" value="${esc(r.date || '')}" aria-label="날짜">
        <select data-f="type" aria-label="구분">
          ${['지출', '수입'].map(t => `<option${t === r.type ? ' selected' : ''}>${t}</option>`).join('')}
        </select>
        <input type="text" inputmode="numeric" data-f="amount" placeholder="금액" aria-label="금액"
          value="${r.amount ? r.amount.toLocaleString('ko-KR') : ''}">
        <select data-f="category_id" aria-label="카테고리"><option value="">카테고리 없음</option>
          ${cats.map(c => `<option value="${c.id}"${c.id === r.category_id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
      </div>
      <input type="text" data-f="memo" value="${esc(r.memo)}" placeholder="메모" aria-label="메모">
      ${r.note && r.note !== '잔액 검산 일치' ? `<div class="img-note">${esc(r.note)}</div>` : ''}
    </div>`;
  }).join('');
  $('#img-actions').hidden = !imgRows.length;
  updateImgSaveButton();
}

function updateImgSaveButton() {
  $('#img-save').textContent = `체크한 ${imgRows.filter(r => r.checked).length}건 저장`;
}

$('#img-rows').addEventListener('input', e => {
  const field = e.target.dataset.f;
  const card = e.target.closest('.img-row');
  if (!field || !card) return;
  const row = imgRows[Number(card.dataset.i)];
  if (field === 'checked') {
    row.checked = e.target.checked;
    card.classList.toggle('off', !row.checked);
    updateImgSaveButton();
  } else if (field === 'amount') {
    formatAmountInput(e.target);
    row.amount = Number(digits(e.target.value)) || null;
  } else if (field === 'category_id') {
    row.category_id = Number(e.target.value) || null;
  } else {
    row[field] = e.target.value;
    if (field === 'type') { row.category_id = null; renderImageRows(); }
  }
});

$('#img-clear').addEventListener('click', () => {
  imgRows = [];
  $('#img-files').value = '';
  $('#img-status').textContent = '';
  renderImageRows();
});

$('#img-save').addEventListener('click', async () => {
  const chosen = imgRows.filter(r => r.checked);
  if (!chosen.length) return toast('저장할 행을 체크하세요');
  const bad = chosen.find(r => !r.date || !r.amount);
  if (bad) return toast('체크한 행에 날짜와 금액을 모두 넣으세요');
  try {
    const result = await api('POST', '/api/import/rows', {
      account_id: Number($('#img-account').value),
      rows: chosen.map(r => ({ date: r.date, type: r.type, amount: r.amount, memo: r.memo.trim(),
                               category_id: r.category_id, balance: r.balance, time: r.time, force: r.status === 'duplicate' })),
    });
    const errors = result.errors.map(x => `${x.row}번째: ${x.error}`).join(', ');
    $('#img-status').textContent = `저장 ${result.added}건, 이미 있어 건너뜀 ${result.skipped}건` +
      (errors ? `, 오류 ${result.errors.length}건 (${errors})` : '');
    toast(`${result.added}건을 저장했습니다`);
    imgRows = [];
    $('#img-files').value = '';
    renderImageRows();
    await reloadAll();
  } catch (err) { report(err); }
});

// ---------------------------------------------------------------- 내역

function fillFilterSelects() {
  fillSelect($('#list-account'), state.accounts.map(a => [a.id, a.name]), '전체 계좌');
  fillSelect($('#list-category'), state.categories.map(c => [c.id, `${c.name} (${c.type})`]), '전체 카테고리');
}
$('#list-account').addEventListener('change', () => renderList().catch(report));
$('#list-category').addEventListener('change', () => renderList().catch(report));

async function renderList() {
  setMonthLabels();
  const params = new URLSearchParams({ month: state.listMonth });
  if ($('#list-account').value) params.set('account_id', $('#list-account').value);
  if ($('#list-category').value) params.set('category_id', $('#list-category').value);
  const [txs, s] = await Promise.all([
    api('GET', `/api/transactions?${params}`), getSummary(state.listMonth)]);
  $('#input-budget-title').textContent = `${Number(state.listMonth.slice(5))}월 예산 현황`;
  $('#input-budgets').innerHTML = budgetHtml(s);

  let income = 0, expense = 0;
  const days = new Map();
  for (const t of txs) {
    if (t.type === '수입') income += t.amount;
    if (t.type === '지출') expense += t.amount;
    if (!days.has(t.date)) days.set(t.date, []);
    days.get(t.date).push(t);
  }
  $('#list-totals').innerHTML =
    `<span>수입 <b>${won(income)}</b></span><span>지출 <b>${won(expense)}</b></span><span>${txs.length}건</span>`;

  const body = $('#list-body');
  if (!txs.length) {
    body.innerHTML = '<p class="empty">이 달의 거래가 없습니다</p>';
    return;
  }
  body.innerHTML = [...days].map(([date, items]) => {
    const dayExpense = items.filter(t => t.type === '지출').reduce((s, t) => s + t.amount, 0);
    return `<div class="day">
      <div class="day-head"><span>${dayLabel(date)}</span><span>${dayExpense ? '지출 ' + won(dayExpense) : ''}</span></div>
      <ul>${items.map(t => {
        const title = t.type === '이체' ? `이체 → ${t.to_account}` : (t.category || '미분류');
        const sign = t.type === '수입' ? '+' : t.type === '지출' ? '−' : '';
        const editing = state.editing?.id === t.id ? ' editing' : '';
        return `<li class="tx${editing}" data-id="${t.id}">
          <div class="tx-main">
            <div class="tx-title">${esc(title)}${t.memo ? ' · ' + esc(t.memo) : ''}</div>
            <div class="tx-sub">${esc(t.account)}${t.source !== 'web' ? ' · ' + esc(t.source) : ''}</div>
          </div>
          <div class="tx-amt ${t.type}">${sign}${t.amount.toLocaleString('ko-KR')}원</div>
        </li>`;
      }).join('')}</ul>
    </div>`;
  }).join('');
  $$('.tx', body).forEach(li => li.addEventListener('click', () => {
    startEdit(txs.find(t => t.id === Number(li.dataset.id)));
  }));
}

// ---------------------------------------------------------------- 요약

function budgetBar(label, spent, budget, note = '') {
  const pct = budget ? Math.round(spent / budget * 100) : (spent ? 100 : 0);
  const over = spent > budget;
  return `<div class="budget">
    <div class="budget-head"><span>${esc(label)}</span><small>${won(spent)} / ${won(budget)}</small></div>
    <div class="bar${over ? ' over' : ''}" role="img" aria-label="${esc(label)} 예산 ${pct}% 사용">
      <div style="width:${Math.min(100, pct)}%"></div></div>
    ${over ? `<div class="over-text">▲ 예산 초과 ${won(spent - budget)}</div>`
           : `<div class="left-text">남은 예산 ${won(budget - spent)} · ${pct}% 사용</div>`}
    ${note}
  </div>`;
}

// 전체(예산 합계 대비 이 달 전체 지출) + 카테고리별 막대
function budgetHtml(s) {
  if (!s.budgets.length) return '<p class="hint">이 달 예산이 없습니다. 설정 › 예산에서 정하세요.</p>';
  const totalBudget = s.budgets.reduce((n, b) => n + b.budget, 0);
  const unbudgeted = s.expense - s.budgets.reduce((n, b) => n + b.spent, 0);
  const note = unbudgeted > 0 ? `<div class="left-text">예산 없는 카테고리 지출 ${won(unbudgeted)} 포함</div>` : '';
  return `<div class="budget-total">${budgetBar('전체', s.expense, totalBudget, note)}</div>` +
    s.budgets.map(b => budgetBar(b.category, b.spent, b.budget)).join('');
}

// 입력 화면의 예산 현황 접힘 상태는 이 브라우저에만 기억한다
const budgetCard = $('#input-budget-card');
if (storageGet('budgetCardClosed')) budgetCard.open = false;
budgetCard.addEventListener('toggle', () => storageSet('budgetCardClosed', !budgetCard.open));

Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
Chart.defaults.color = '#52514e';

async function renderSummary() {
  setMonthLabels();
  const s = await getSummary(state.summaryMonth);
  $('#sum-income').textContent = won(s.income);
  $('#sum-expense').textContent = won(s.expense);
  $('#sum-net').textContent = won(s.net);
  $('#sum-budgets').innerHTML = budgetHtml(s);

  // 카테고리 도넛: 상위 7개 + 기타
  const top = s.categories.slice(0, 7);
  const rest = s.categories.slice(7).reduce((sum, c) => sum + c.amount, 0);
  const slices = top.map((c, i) => ({ label: c.category, value: c.amount, color: SERIES[i] }));
  if (rest) slices.push({ label: '기타', value: rest, color: OTHER_COLOR });
  drawDonut(slices, s.expense);

  // 12개월 추이
  drawTrend(s.trend);

  // 계좌 잔액
  $('#sum-balance-note').textContent = state.summaryMonth === thisMonth() ? '현재' : `${monthLabel(state.summaryMonth)} 말 기준`;
  const total = s.accounts.reduce((sum, a) => sum + a.balance, 0);
  $('#sum-accounts').innerHTML = s.accounts.map(a =>
    `<tr><td>${esc(a.name)} <span class="kind">${esc(a.kind)}</span></td><td class="num">${won(a.balance)}</td></tr>`
  ).join('') + `<tr class="total"><td>합계</td><td class="num">${won(total)}</td></tr>`;
}

function drawDonut(slices, total) {
  const legend = $('#donut-legend');
  if (!slices.length) {
    state.charts.donut?.destroy();
    state.charts.donut = null;
    legend.innerHTML = '<li class="hint">이 달 지출이 없습니다</li>';
    return;
  }
  const data = {
    labels: slices.map(s => s.label),
    datasets: [{ data: slices.map(s => s.value), backgroundColor: slices.map(s => s.color),
                 borderColor: '#ffffff', borderWidth: 2, hoverOffset: 4 }],
  };
  if (state.charts.donut) {
    state.charts.donut.data = data;
    state.charts.donut.update();
  } else {
    state.charts.donut = new Chart($('#chart-donut'), {
      type: 'doughnut',
      data,
      options: {
        maintainAspectRatio: false, cutout: '62%', animation: { duration: 200 },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${won(ctx.parsed)}` } },
        },
      },
    });
  }
  legend.innerHTML = slices.map(s => `<li><i style="background:${s.color}"></i>
    <span class="name">${esc(s.label)}</span><span>${won(s.value)}</span>
    <span class="pct">${Math.round(s.value / total * 100)}%</span></li>`).join('');
}

function drawTrend(trend) {
  const data = {
    labels: trend.map(t => `${Number(t.month.slice(5))}월`),
    datasets: [
      { label: '수입', data: trend.map(t => t.income), backgroundColor: SERIES[0] },
      { label: '지출', data: trend.map(t => t.expense), backgroundColor: SERIES[1] },
    ].map(d => ({ ...d, borderRadius: 4, borderSkipped: 'start', categoryPercentage: 0.7, barPercentage: 0.9 })),
  };
  if (state.charts.trend) {
    state.charts.trend.data = data;
    state.charts.trend.update();
    return;
  }
  state.charts.trend = new Chart($('#chart-trend'), {
    type: 'bar',
    data,
    options: {
      maintainAspectRatio: false, animation: { duration: 200 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', align: 'end', labels: { boxWidth: 10, boxHeight: 10 } },
        tooltip: {
          callbacks: {
            title: items => trend[items[0].dataIndex].month,
            label: ctx => ` ${ctx.dataset.label}: ${won(ctx.parsed.y)}`,
            footer: items => `순액: ${won(trend[items[0].dataIndex].net)}`,
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, font: { size: 11 } } },
        y: {
          beginAtZero: true, border: { display: false }, grid: { color: '#ecebe7' },
          ticks: { font: { size: 11 }, maxTicksLimit: 5,
                   callback: v => v >= 10000 ? `${(v / 10000).toLocaleString('ko-KR')}만` : v.toLocaleString('ko-KR') },
        },
      },
    },
  });
}

// ---------------------------------------------------------------- 설정

async function renderSettings() {
  renderAccounts();
  renderCategories();
  await renderBudgets();
}

function renderAccounts() {
  $('#acc-list').innerHTML = state.accounts.map(a => `<li>
    <span class="grow">${esc(a.name)} <small>${esc(a.kind)} · 시작 ${won(a.opening_balance)}</small></span>
    <button type="button" data-edit="${a.id}">수정</button>
    <button type="button" class="danger" data-del="${a.id}">삭제</button></li>`).join('')
    || '<li class="hint">계좌를 추가하세요</li>';
}

function renderCategories() {
  const sorted = [...state.categories].sort((a, b) => b.type.localeCompare(a.type) || a.name.localeCompare(b.name));
  $('#cat-list').innerHTML = sorted.map(c => `<li>
    <span class="grow">${esc(c.name)} <small>${esc(c.type)}</small></span>
    <button type="button" data-edit="${c.id}">수정</button>
    <button type="button" class="danger" data-del="${c.id}">삭제</button></li>`).join('')
    || '<li class="hint">카테고리를 추가하세요</li>';
}

// 계좌·카테고리 편집 폼 공통 처리
function setupEditor({ prefix, path, label, items, fill, read }) {
  const editForm = $(`#${prefix}-form`);
  const reset = () => {
    editForm.reset();
    $(`#${prefix}-id`).value = '';
    $(`#${prefix}-submit`).textContent = '추가';
    $(`#${prefix}-cancel`).hidden = true;
  };
  $(`#${prefix}-cancel`).addEventListener('click', reset);
  editForm.addEventListener('submit', async e => {
    e.preventDefault();
    const id = $(`#${prefix}-id`).value;
    try {
      await api(id ? 'PUT' : 'POST', id ? `${path}/${id}` : path, read());
      toast(id ? '수정했습니다' : '추가했습니다');
      reset();
      await reloadAll();
    } catch (err) { report(err); }
  });
  $(`#${prefix}-list`).addEventListener('click', async e => {
    const editId = e.target.dataset.edit;
    const delId = e.target.dataset.del;
    if (editId) {
      const item = items().find(x => x.id === Number(editId));
      $(`#${prefix}-id`).value = item.id;
      fill(item);
      $(`#${prefix}-submit`).textContent = '수정 저장';
      $(`#${prefix}-cancel`).hidden = false;
      $(`#${prefix}-name`).focus();
    } else if (delId) {
      const item = items().find(x => x.id === Number(delId));
      if (!confirm(`${label} '${item.name}'을(를) 삭제할까요?`)) return;
      try {
        await api('DELETE', `${path}/${delId}`);
        toast('삭제했습니다');
        await reloadAll();
      } catch (err) { report(err); }
    }
  });
}

setupEditor({
  prefix: 'acc', path: '/api/accounts', label: '계좌', items: () => state.accounts,
  fill: a => {
    $('#acc-name').value = a.name;
    $('#acc-kind').value = a.kind;
    $('#acc-opening').value = a.opening_balance.toLocaleString('ko-KR');
  },
  read: () => ({ name: $('#acc-name').value.trim(), kind: $('#acc-kind').value,
                 opening_balance: Number(digits($('#acc-opening').value)) || 0 }),
});
setupEditor({
  prefix: 'cat', path: '/api/categories', label: '카테고리', items: () => state.categories,
  fill: c => { $('#cat-name').value = c.name; $('#cat-type').value = c.type; },
  read: () => ({ name: $('#cat-name').value.trim(), type: $('#cat-type').value }),
});
$('#acc-opening').addEventListener('input', e => {
  const negative = e.target.value.trim().startsWith('-');
  formatAmountInput(e.target);
  if (negative) e.target.value = '-' + e.target.value;
});

async function renderBudgets() {
  setMonthLabels();
  const budgets = await api('GET', `/api/budgets?month=${state.budgetMonth}`);
  const byId = new Map(budgets.map(b => [b.category_id, b.amount]));
  const expenseCats = state.categories.filter(c => c.type === '지출');
  $('#budget-list').innerHTML = expenseCats.map(c => `<li>
    <span class="grow">${esc(c.name)}</span>
    <input type="text" inputmode="numeric" data-cat="${c.id}" data-old="${byId.get(c.id) ?? ''}"
      value="${byId.has(c.id) ? byId.get(c.id).toLocaleString('ko-KR') : ''}" placeholder="없음"
      aria-label="${esc(c.name)} 예산"></li>`).join('')
    || '<li class="hint">지출 카테고리를 먼저 추가하세요</li>';
  $$('#budget-list input').forEach(i => i.addEventListener('input', () => {
    formatAmountInput(i);
    showBudgetTotal();
  }));
  showBudgetTotal();
}

function showBudgetTotal() {
  const total = $$('#budget-list input').reduce((n, i) => n + (Number(digits(i.value)) || 0), 0);
  $('#budget-total').textContent = `예산 합계 ${won(total)}`;
}

$('#budget-copy').addEventListener('click', async () => {
  const month = state.budgetMonth;
  const prev = addMonth(month, -1);
  try {
    const [prevBudgets, current] = await Promise.all([
      api('GET', `/api/budgets?month=${prev}`), api('GET', `/api/budgets?month=${month}`)]);
    const have = new Set(current.map(b => b.category_id));
    const todo = prevBudgets.filter(b => !have.has(b.category_id));
    if (!prevBudgets.length) return toast(`${monthLabel(prev)} 예산이 없습니다`);
    if (!todo.length) return toast('이미 모든 카테고리에 예산이 있습니다');
    if (!confirm(`${monthLabel(prev)} 예산 ${todo.length}건을 ${monthLabel(month)}로 복사할까요?\n` +
                 '이미 정한 예산은 그대로 둡니다.')) return;
    for (const b of todo) {
      await api('POST', '/api/budgets', { category_id: b.category_id, month, amount: b.amount });
    }
    state.summaries = {};
    toast(`예산 ${todo.length}건을 복사했습니다`);
    await renderBudgets();
  } catch (err) { report(err); }
});

$('#budget-form').addEventListener('submit', async e => {
  e.preventDefault();
  let changed = 0;
  try {
    for (const input of $$('#budget-list input')) {
      const value = digits(input.value);
      if (value === input.dataset.old) continue;
      if (value === '') {
        await api('DELETE', `/api/budgets/${input.dataset.cat}/${state.budgetMonth}`);
      } else {
        await api('POST', '/api/budgets', {
          category_id: Number(input.dataset.cat), month: state.budgetMonth, amount: Number(value) });
      }
      changed++;
    }
    state.summaries = {};
    toast(changed ? `예산 ${changed}건을 저장했습니다` : '바뀐 예산이 없습니다');
    await renderBudgets();
  } catch (err) { report(err); }
});

// ---------------------------------------------------------------- CSV 가져오기

function parseCsv(text) {
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

async function readImportFile() {
  const file = $('#imp-file').files[0];
  $('#imp-result').textContent = '';
  if (!file) { $('#imp-mapping').hidden = true; return; }
  const buffer = await file.arrayBuffer();
  state.importText = new TextDecoder($('#imp-encoding').value).decode(buffer).replace(/^﻿/, '');
  const skip = Number($('#imp-skip').value) || 0;
  const rows = parseCsv(state.importText).slice(skip);
  const header = (rows[0] || []).map(h => h.trim());
  if (!header.length) { $('#imp-result').textContent = '머리글 행을 찾지 못했습니다'; return; }

  const saved = storageGet('importMapping:' + header.join('|')) || {};
  const options = header.map(h => [h, h]);
  $$('#imp-mapping select[data-map]').forEach(sel => {
    fillSelect(sel, options, '(없음)');
    sel.value = saved[sel.dataset.map] && header.includes(saved[sel.dataset.map]) ? saved[sel.dataset.map] : '';
  });
  const memoSaved = new Set([].concat(saved.memo || []));
  $('#imp-memo').innerHTML = header.map(h =>
    `<label><input type="checkbox" value="${esc(h)}"${memoSaved.has(h) ? ' checked' : ''}> ${esc(h)}</label>`).join('');
  const mode = saved.amount ? 'single' : 'split';
  $(`input[name=imp-mode][value=${mode}]`).checked = true;
  syncImportMode();

  const sample = rows.slice(1, 4);
  $('#imp-preview').innerHTML = `<table><tr>${header.map(h => `<th>${esc(h)}</th>`).join('')}</tr>${
    sample.map(r => `<tr>${header.map((_, i) => `<td>${esc(r[i] ?? '')}</td>`).join('')}</tr>`).join('')}</table>`;
  $('#imp-mapping').hidden = false;
}

function syncImportMode() {
  const single = $('input[name=imp-mode]:checked').value === 'single';
  $('#imp-single').hidden = !single;
  $('#imp-split').hidden = single;
}

['#imp-file', '#imp-encoding', '#imp-skip'].forEach(sel =>
  $(sel).addEventListener('change', () => readImportFile().catch(report)));
$$('input[name=imp-mode]').forEach(r => r.addEventListener('change', syncImportMode));

$('#import-form').addEventListener('submit', async e => {
  e.preventDefault();
  const mapping = {};
  $$('#imp-mapping select[data-map]').forEach(sel => { if (sel.value) mapping[sel.dataset.map] = sel.value; });
  if ($('input[name=imp-mode]:checked').value === 'single') { delete mapping.withdraw; delete mapping.deposit; }
  else delete mapping.amount;
  mapping.memo = $$('#imp-memo input:checked').map(i => i.value);
  try {
    const result = await api('POST', '/api/import/csv', {
      csv: state.importText, account_id: Number($('#imp-account').value),
      skip_rows: Number($('#imp-skip').value) || 0, mapping });
    const header = $$('#imp-memo input').map(i => i.value);
    storageSet('importMapping:' + header.join('|'), mapping);
    const errors = result.errors.slice(0, 5).map(x => `${x.line}행: ${x.error}`).join(', ');
    $('#imp-result').textContent = `추가 ${result.added}건, 중복 건너뜀 ${result.skipped}건` +
      (result.errors.length ? `, 오류 ${result.errors.length}건 (${errors})` : '');
    await reloadAll();
  } catch (err) {
    $('#imp-result').textContent = err.message;
  }
});

// ---------------------------------------------------------------- 데이터·백업

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function showDataInfo() {
  const d = ledger?.data;
  if (!d) return;
  $('#data-info').textContent = `저장소 ${ledger.store.repo} · 거래 ${d.transactions.length}건 · 계좌 ${d.accounts.length} · 카테고리 ${d.categories.length}`;
}

$('#export-csv').addEventListener('click', () => {
  if (ledger?.data) download(`transactions-${today()}.csv`, ledger.exportCsv(), 'text/csv;charset=utf-8');
});
$('#export-json').addEventListener('click', () => {
  if (ledger?.data) download(`ledger-backup-${today()}.json`, ledger.exportJson(), 'application/json');
});

async function showOcrInfo() {
  const cached = await (await loadOcr()).isCached();
  $('#ocr-info').textContent = cached ? '사진 인식 파일을 이 기기에 받아 두었습니다.'
    : '아직 받지 않았습니다. 와이파이에서 미리 받아 두면 사진 입력이 바로 시작됩니다.';
  $('#ocr-prepare').hidden = cached;
}
$('#ocr-prepare').addEventListener('click', async () => {
  const button = $('#ocr-prepare');
  button.disabled = true;
  try {
    await (await loadOcr()).prepare(mb => { $('#ocr-info').textContent = downloadNote(mb); });
    toast('사진 인식 준비가 끝났습니다');
  } catch (err) {
    $('#ocr-info').textContent = err.message;
  } finally {
    button.disabled = false;
    showOcrInfo().catch(() => {});
  }
});
$('#data-card').addEventListener('toggle', () => showOcrInfo().catch(() => {}));

// ---------------------------------------------------------------- 시작

$('#tx-date').value = today();
setMonthLabels();
const savedConfig = storageGet(CONFIG_KEY);
if (savedConfig?.token && savedConfig?.repo) {
  connect(savedConfig);
  start().catch(err => {
    // 토큰 문제면 다시 입력받고, 연결 문제면 저장된 토큰을 그대로 두고 새로고침으로 다시 시도하게 한다
    showLogin(err.status === 401 ? err.message : `${err.message} — 새로고침하면 다시 시도합니다`);
  });
} else {
  showLogin();
}
