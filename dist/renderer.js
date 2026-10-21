const tauriInvoke =
  window.__TAURI__?.core?.invoke || window.__TAURI__?.tauri?.invoke;
const isBrowserHosted = !window.wbApi && !tauriInvoke;

async function browserApiRequest(body) {
  const response = await fetch("api.php", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = response.status === 204 ? "" : await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch (_err) { payload = null; }
  if (!response.ok) throw new Error((payload && payload.error) || text || ("HTTP " + response.status));
  return payload;
}

const wbApi = window.wbApi || (tauriInvoke
  ? { reportDetailByPeriod: (params) => tauriInvoke("report_detail_by_period", params) }
  : {
      isBrowserHosted: true,
      reportDetailByPeriod: (params) => browserApiRequest(params),
      listAccounts: () => browserApiRequest({ action: "listAccounts" }),
      saveAccount: (account) => browserApiRequest({ action: "saveAccount", ...account }),
      deleteAccount: (id) => browserApiRequest({ action: "deleteAccount", id }),
    });

const state = {
  lastSummary: null,
  authorized: false,
  busy: false,
  cooldownUntil: 0,
  cooldownTimer: null,
  accounts: [],
  activeAccountId: null,
};

const el = (id) => document.getElementById(id);
const ACCOUNTS_KEY = "wb-tax-base-accounts";
const LEGACY_TOKEN_KEY = "wb-tax-base-token";

function getQuarterRange(year, quarter) {
  const q = Number(quarter);
  const y = Number(year);
  const startMonth = (q - 1) * 3;
  const start = new Date(Date.UTC(y, startMonth, 1));
  const end = new Date(Date.UTC(y, startMonth + 3, 0));
  const toDate = (date) => date.toISOString().slice(0, 10);
  return { beginTime: toDate(start), endTime: toDate(end) };
}

function formatMoney(value) {
  const num = Number(value || 0);
  return num.toLocaleString("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function saveAccounts() {
  if (isBrowserHosted) return;
  try {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(state.accounts));
  } catch (_err) {
    el("auth-result").textContent = "Не удалось сохранить кабинеты в этом браузере.";
  }
}

async function loadAccounts() {
  if (isBrowserHosted) {
    try {
      const local = JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || "[]");
      const oldToken = localStorage.getItem(LEGACY_TOKEN_KEY) || "";
      const legacy = Array.isArray(local) ? local.filter((item) => item && typeof item.token === "string" && item.token.trim()) : [];
      if (oldToken) legacy.push({ id: createAccountId(), name: "Кабинет 1", token: oldToken });
      let serverAccounts = await wbApi.listAccounts();
      for (const account of legacy) {
        await wbApi.saveAccount({ id: account.id || createAccountId(), name: account.name || "Кабинет", token: account.token });
      }
      if (legacy.length) {
        localStorage.removeItem(ACCOUNTS_KEY);
        localStorage.removeItem(LEGACY_TOKEN_KEY);
      }
      if (legacy.length) serverAccounts = await wbApi.listAccounts();
      state.accounts = Array.isArray(serverAccounts) ? serverAccounts : [];
      localStorage.setItem("wb-tax-base-server-migrated", "1");
    } catch (err) {
      state.accounts = [];
      el("auth-result").textContent = "Не удалось загрузить общие кабинеты: " + extractErrorDetail(err);
      el("auth-result").style.display = "block";
    }
    return;
  }
  try {
    const saved = JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || "[]");
    if (Array.isArray(saved)) state.accounts = saved.filter((account) => account && typeof account.token === "string");
    if (!state.accounts.length) {
      const oldToken = localStorage.getItem(LEGACY_TOKEN_KEY) || "";
      if (oldToken) {
        state.accounts = [{ id: createAccountId(), name: "Кабинет 1", token: oldToken }];
        saveAccounts();
        localStorage.removeItem(LEGACY_TOKEN_KEY);
      }
    }
  } catch (_err) {
    state.accounts = [];
  }
}

function createAccountId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function activeAccount() {
  return state.accounts.find((account) => account.id === state.activeAccountId);
}

function renderAccounts() {
  const select = el("account-select");
  select.replaceChildren();
  const newOption = document.createElement("option");
  newOption.value = "__new__";
  newOption.textContent = "+ Новый кабинет";
  select.append(newOption);
  for (const account of state.accounts) {
    const option = document.createElement("option");
    option.value = account.id;
    option.textContent = account.name || "Кабинет";
    select.append(option);
  }

  const account = activeAccount();
  select.value = account ? account.id : "__new__";
  el("account-name").value = account?.name || "";
  el("token").value = isBrowserHosted ? "" : (account?.token || "");
  el("token").placeholder = isBrowserHosted && account ? "Оставьте пустым, если не меняете токен" : "WB токен категории «Финансы»";
  el("remove-account").disabled = !account;
  el("auth").textContent = account ? "Сохранить изменения" : "Добавить кабинет";
  state.cooldownUntil = account?.cooldownUntil || 0;
  setAuthorized(Boolean(account && (account.token || account.hasToken)));
}

function normalizeNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === "string") {
    const normalized = value.replace(/\s/g, "").replace(",", ".");
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function normalizeReportRow(row) {
  const aliases = {
    report_type: "reportType",
    retail_amount: "retailAmount",
    doc_type_name: "docTypeName",
    cashback_discount: "cashbackDiscount",
    supplier_oper_name: "sellerOperName",
    ppvz_for_pay: "forPay",
    delivery_rub: "deliveryService",
    acceptance: "paidAcceptance",
    storage_fee: "paidStorage",
    deduction: "deduction",
    penalty: "penalty",
    payment_processing: "paymentProcessing",
    acquiring_fee: "acquiringFee",
    ppvz_reward: "ppvzReward",
    rebill_logistic_cost: "rebillLogisticCost",
    srid: "srid",
    site_country: "country",
    nm_id: "nmId",
    date_to: "dateTo",
    rrd_id: "rrdId",
  };
  const normalized = { ...row };
  for (const [legacy, current] of Object.entries(aliases)) {
    if (normalized[legacy] === undefined && normalized[current] !== undefined) {
      normalized[legacy] = normalized[current];
    }
  }
  return normalized;
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function sumField(rows, field, filter) {
  let total = 0;
  for (const row of rows) {
    if (filter && !filter(row)) continue;
    total += normalizeNumber(row?.[field]);
  }
  return total;
}

function getYearForVat(dateTo, rows) {
  if (dateTo && dateTo.length >= 4) {
    const year = Number(dateTo.slice(0, 4));
    return Number.isFinite(year) ? year : 2025;
  }
  const fallback = rows?.[0]?.date_to;
  if (fallback && String(fallback).length >= 4) {
    const year = Number(String(fallback).slice(0, 4));
    return Number.isFinite(year) ? year : 2025;
  }
  return 2025;
}

function calculateTaxBase(rows, dateTo) {
  const rowsReport = rows.filter((row) => Number(row?.report_type) === 1);
  const warnings = [];

  if (!rowsReport.length) {
    warnings.push("Нет строк с report_type = 1.");
  }

  const totalSales = sumField(
    rowsReport,
    "retail_amount",
    (row) => row?.doc_type_name === "Продажа",
  );
  const totalReturns = sumField(
    rowsReport,
    "retail_amount",
    (row) => row?.doc_type_name === "Возврат",
  );
  const netSalesRaw = totalSales - totalReturns;
  const loyaltyComp = sumField(rowsReport, "cashback_discount");
  const line1_1 = netSalesRaw - loyaltyComp;

  let ppvzForPayNet = 0;
  for (const row of rowsReport) {
    if (row?.supplier_oper_name === "Продажа") {
      ppvzForPayNet += normalizeNumber(row?.ppvz_for_pay);
    } else if (row?.supplier_oper_name === "Возврат") {
      ppvzForPayNet -= normalizeNumber(row?.ppvz_for_pay);
    }
  }

  const deliveryRub = sumField(rowsReport, "delivery_rub");
  const acceptance = sumField(rowsReport, "acceptance");
  const storageFee = sumField(rowsReport, "storage_fee");
  const deduction = sumField(rowsReport, "deduction");
  const penalties = sumField(rowsReport, "penalty");

  const lineTotal =
    netSalesRaw -
    ppvzForPayNet +
    deliveryRub +
    acceptance +
    storageFee +
    deduction +
    penalties;

  let acqNet = 0;
  for (const row of rowsReport) {
    if (row?.payment_processing !== "Перевыставление эквайринга") continue;
    if (row?.supplier_oper_name === "Продажа") {
      acqNet += normalizeNumber(row?.acquiring_fee);
    } else if (row?.supplier_oper_name === "Возврат") {
      acqNet -= normalizeNumber(row?.acquiring_fee);
    }
  }

  let ppvzReward = 0;
  for (const row of rowsReport) {
    if (row?.supplier_oper_name === "Возврат") {
      ppvzReward -= normalizeNumber(row?.ppvz_reward);
    } else {
      ppvzReward += normalizeNumber(row?.ppvz_reward);
    }
  }
  const rebillLogistic = sumField(rowsReport, "rebill_logistic_cost");
  const agentExp = ppvzReward + rebillLogistic;

  const reportYear = getYearForVat(dateTo, rowsReport);
  const vatRate = reportYear >= 2026 ? 1.22 : 1.2;
  const commissionWithVat =
    lineTotal - acqNet - agentExp - penalties - deduction;
  const line2_1 = commissionWithVat / vatRate;

  let line4 = 0;
  for (const row of rowsReport) {
    const srid = row?.srid;
    if (typeof srid === "string" && srid.startsWith("defect")) {
      line4 += normalizeNumber(row?.ppvz_for_pay);
    }
  }

  const eaesSaleNmIds = new Set();
  let totalPpvz = 0;
  let totalDelivery = 0;

  for (const row of rows) {
    if (["", null, "Россия"].includes(row?.site_country)) continue;
    if (row?.doc_type_name === "Продажа") {
      eaesSaleNmIds.add(row?.nm_id);
      totalPpvz += round2(normalizeNumber(row?.ppvz_for_pay));
    }
  }

  for (const row of rows) {
    if (["", null, "Россия"].includes(row?.site_country)) continue;
    if (
      row?.supplier_oper_name === "Логистика" &&
      eaesSaleNmIds.has(row?.nm_id)
    ) {
      totalDelivery += round2(normalizeNumber(row?.delivery_rub));
    }
  }

  const eaeuTotal = round2(totalPpvz - totalDelivery);
  const vvAbs = line2_1 < 0 ? Math.abs(line2_1) : 0;
  const ruBase = line1_1 + vvAbs + line4;
  const totalBase = ruBase + eaeuTotal;
  const tax = totalBase * 0.06;

  if (!totalSales && !totalReturns) {
    warnings.push("Не найдены строки продаж/возвратов для 1.1.");
  }
  if (!Number.isFinite(line2_1)) {
    warnings.push("Не удалось рассчитать строку 2.1 (вознаграждение ВВ).");
  }

  return {
    ruBase,
    eaeuBase: eaeuTotal,
    totalBase,
    tax,
    line1_1,
    line2_1,
    line4,
    warnings,
    meta: {
      rowsTotal: rows.length,
      rowsReport: rowsReport.length,
      reportYear,
    },
  };
}

function renderResults(summary) {
  const results = el("results");
  const values = [
    formatMoney(summary.ruBase),
    formatMoney(summary.eaeuBase),
    formatMoney(summary.totalBase),
    formatMoney(summary.tax),
  ];
  const cards = results.querySelectorAll(".result-card .value");
  cards.forEach((node, idx) => {
    node.textContent = values[idx] || "—";
  });

  const details = [
    `Всего стоимость реализованного товара: ${formatMoney(summary.line1_1)}`,
    `Вознаграждение ВВ без НДС: ${formatMoney(summary.line2_1)}`,
    `Компенсация ущерба: ${formatMoney(summary.line4)}`,
    `ЕАЭС сумма выкупа: ${formatMoney(summary.eaeuBase)}`,
  ];
  renderDiagnostics(summary.warnings.concat(details));
}

function clearResults() {
  const values = el("results").querySelectorAll(".result-card .value");
  values.forEach((node) => {
    node.textContent = "—";
  });
  renderDiagnostics(["Нет данных. Выполните расчет."]);
}

function renderDiagnostics(lines) {
  const diag = el("diagnostics");
  diag.innerHTML = (lines || []).map((line) => `• ${line}`).join("<br>");
}

function formatApiSample(rows) {
  if (!rows || !rows.length) return "[]";
  const sample = rows[0];
  try {
    const raw = JSON.stringify(sample);
    return raw.length > 800 ? `${raw.slice(0, 800)}…` : raw;
  } catch (_err) {
    return "[object]";
  }
}

function extractErrorDetail(err) {
  let message;
  if (typeof err === "string") {
    message = err;
  } else if (err instanceof Error && err.message) {
    message = err.message;
  } else if (err && typeof err === "object") {
    message = err.message || err.error || err.details || err.detail;
    if (!message) {
      try {
        message = JSON.stringify(err);
      } catch (_e) {
        message = "Неизвестная ошибка API.";
      }
    }
  } else if (err === undefined || err === null || err === "") {
    message = "API вернул пустую ошибку. Проверьте подключение и повторите запрос.";
  } else {
    message = String(err);
  }
  message = String(message);
  const jsonStart = message.indexOf("{");
  if (jsonStart === -1) return message;
  const payload = message.slice(jsonStart);
  try {
    const parsed = JSON.parse(payload);
    return parsed.detail || parsed.details || parsed.message || message;
  } catch (_e) {
    const detailMatch =
      payload.match(/"detail"\s*:\s*"([^"]+)"/) ||
      payload.match(/"details"\s*:\s*"([^"]+)"/);
    if (detailMatch && detailMatch[1]) return detailMatch[1];
    return message;
  }
}

function renderAuth(info) {
  const authEl = el("auth-result");
  if (!info) {
    authEl.textContent = "";
    authEl.style.display = "none";
    return;
  }
  const name = info.name || "—";
  const sid = info.sid || "—";
  const tradeMark = info.tradeMark || "—";
  authEl.innerHTML = [
    `<strong>${name}</strong>`,
    `SID: ${sid}`,
    `Товарный знак: ${tradeMark}`,
  ].join("<br>");
  authEl.style.display = "block";
}

function setAuthorized(isAuthorized) {
  state.authorized = isAuthorized;
  ["period-mode", "quarter", "year", "date-from", "date-to"].forEach((id) => {
    const node = el(id);
    if (node) node.disabled = !isAuthorized || state.busy;
  });
  const fetchBtn = el("fetch");
  if (fetchBtn) {
    fetchBtn.disabled =
      !isAuthorized || state.busy || Date.now() < state.cooldownUntil;
  }
  const sourcesCard = el("sources-card");
  const resultsCard = el("results-card");
  if (sourcesCard)
    sourcesCard.classList.toggle("is-disabled", !isAuthorized || state.busy);
  if (resultsCard) resultsCard.classList.toggle("is-disabled", !isAuthorized);
  const results = el("results");
  const diagnostics = el("diagnostics");
  if (!isAuthorized) {
    results.classList.add("is-disabled");
    diagnostics.classList.add("is-disabled");
    clearResults();
    diagnostics.textContent = "Требуется авторизация.";
  } else {
    results.classList.remove("is-disabled");
    diagnostics.classList.remove("is-disabled");
  }
}

function updatePeriodMode() {
  const mode = el("period-mode").value;
  const quarterRow = el("quarter-row");
  const dateRow = el("date-row");
  const yearWrap = el("year-wrap");

  if (mode === "dates") {
    quarterRow.style.display = "none";
    dateRow.style.display = "";
    yearWrap.style.display = "none";
  } else {
    quarterRow.style.display = "";
    dateRow.style.display = "none";
    yearWrap.style.display = "";
  }
}

async function fetchReportDetailByPeriodPaged(
  credential,
  dateFrom,
  dateTo,
  onProgress,
) {
  const limit = 99000;
  let rrdid = 0;
  let all = [];
  let batch = 0;
  let lastRrdId = 0;
  const cooldownSeconds = 60;

  async function waitCooldown() {
    for (let remaining = cooldownSeconds; remaining > 0; remaining -= 1) {
      if (onProgress) onProgress({ phase: "cooldown", remaining });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  async function requestPage() {
    while (true) {
      try {
        return await wbApi.reportDetailByPeriod({
          ...(isBrowserHosted ? { accountId: credential } : { token: credential }),
          dateFrom,
          dateTo,
          limit,
          rrdid,
          period: "daily",
        });
      } catch (err) {
        const message = String(err && err.message ? err.message : err);
        if (message.includes("429")) {
          await waitCooldown();
          continue;
        }
        throw err;
      }
    }
  }

  while (true) {
    const rows = await requestPage();

    if (!Array.isArray(rows) || rows.length === 0) {
      break;
    }

    all = all.concat(rows);
    batch += 1;
    if (onProgress) onProgress({ phase: "progress", batch, total: all.length });

    const last = rows[rows.length - 1];
    const nextRrdId = last?.rrd_id ?? last?.rrdId ?? last?.rrdid;
    if (!nextRrdId || nextRrdId === rrdid) {
      lastRrdId = nextRrdId || rrdid;
      break;
    }
    rrdid = nextRrdId;
    lastRrdId = nextRrdId;
    await waitCooldown();
  }

  return {
    rows: all,
    debug: {
      batch,
      total: all.length,
      lastRrdId,
      request: { dateFrom, dateTo, limit, period: "daily" },
    },
  };
}

async function authorize() {
  const name = el("account-name").value.trim();
  const token = el("token").value.trim();
  const authEl = el("auth-result");
  let account = activeAccount();
  if (!name || (!account && !token)) {
    authEl.textContent = "Укажите название кабинета и токен категории «Финансы».";
    authEl.style.display = "block";
    return;
  }
  try {
    if (isBrowserHosted) {
      const saved = await wbApi.saveAccount({ id: account?.id, name, token });
      state.accounts = saved;
      const retainedId = account?.id || state.accounts[state.accounts.length - 1]?.id;
      state.activeAccountId = retainedId || null;
    } else {
      if (!account) {
        account = { id: createAccountId(), name, token };
        state.accounts.push(account);
        state.activeAccountId = account.id;
      } else {
        account.name = name;
        account.token = token;
      }
      saveAccounts();
    }
    renderAccounts();
    el("token").value = "";
    authEl.textContent = "Кабинет сохранён на сервере и доступен с других устройств.";
    authEl.style.display = "block";
  } catch (err) {
    authEl.textContent = "Не удалось сохранить кабинет: " + extractErrorDetail(err);
    authEl.style.display = "block";
  }
}

function selectAccount() {
  const id = el("account-select").value;
  state.activeAccountId = id === "__new__" ? null : id;
  clearResults();
  renderAccounts();
  if (!activeAccount()) {
    el("auth-result").textContent = "Введите данные нового кабинета.";
    el("auth-result").style.display = "block";
  }
}

async function removeActiveAccount() {
  const account = activeAccount();
  if (!account) return;
  try {
    if (isBrowserHosted) state.accounts = await wbApi.deleteAccount(account.id);
    else {
      state.accounts = state.accounts.filter((item) => item.id !== account.id);
      saveAccounts();
    }
    state.activeAccountId = null;
    clearResults();
    renderAccounts();
    el("auth-result").textContent = "Кабинет удалён.";
  } catch (err) {
    el("auth-result").textContent = "Не удалось удалить кабинет: " + extractErrorDetail(err);
  }
  el("auth-result").style.display = "block";
}

function setBusy(isBusy) {
  state.busy = isBusy;
  ["period-mode", "quarter", "year", "date-from", "date-to"].forEach((id) => {
    const node = el(id);
    if (node) node.disabled = !state.authorized || isBusy;
  });
  ["account-select", "account-name", "token", "auth"].forEach((id) => {
    const node = el(id);
    if (node) node.disabled = isBusy;
  });
  el("remove-account").disabled = isBusy || !activeAccount();
  const fetchBtn = el("fetch");
  if (fetchBtn) {
    fetchBtn.disabled =
      !state.authorized || isBusy || Date.now() < state.cooldownUntil;
  }
  const sourcesCard = el("sources-card");
  if (sourcesCard)
    sourcesCard.classList.toggle("is-disabled", !state.authorized || isBusy);
  const overlay = el("results-overlay");
  if (overlay) overlay.classList.toggle("is-visible", isBusy);
}

function startCooldown(seconds) {
  state.cooldownUntil = Date.now() + seconds * 1000;
  const account = activeAccount();
  if (account) {
    account.cooldownUntil = state.cooldownUntil;
    saveAccounts();
  }
  const hint = el("fetch-hint");
  if (state.cooldownTimer) {
    clearInterval(state.cooldownTimer);
  }
  state.cooldownTimer = setInterval(() => {
    const remaining = Math.max(
      0,
      Math.ceil((state.cooldownUntil - Date.now()) / 1000),
    );
    const fetchBtn = el("fetch");
    if (fetchBtn) {
      fetchBtn.disabled = !state.authorized || state.busy || remaining > 0;
    }
    if (remaining > 0) {
      hint.textContent = `Лимит WB: осталось ${remaining}с до следующего запроса.`;
    } else {
      clearInterval(state.cooldownTimer);
      state.cooldownTimer = null;
      if (!state.busy) hint.textContent = "";
    }
  }, 1000);
}

async function fetchAndCompute() {
  if (!wbApi) {
    el("fetch-hint").textContent =
      "Tauri API недоступен. Перезапустите приложение.";
    return;
  }

  const account = activeAccount();
  const credential = isBrowserHosted ? account?.id : el("token").value.trim();
  const mode = el("period-mode").value;
  const dateFromInput = el("date-from").value;
  const dateToInput = el("date-to").value;
  const quarter = el("quarter").value;
  const year = el("year").value;
  const hint = el("fetch-hint");

  if (!credential) {
    hint.textContent = "Выберите или добавьте кабинет.";
    return;
  }
  if (!state.authorized) {
    hint.textContent = "Сначала выполните авторизацию.";
    return;
  }
  if (Date.now() < state.cooldownUntil) {
    const remaining = Math.max(
      0,
      Math.ceil((state.cooldownUntil - Date.now()) / 1000),
    );
    hint.textContent = `Лимит WB: осталось ${remaining}с до следующего запроса.`;
    return;
  }

  let dateFrom = dateFromInput;
  let dateTo = dateToInput;

  if (mode === "quarter") {
    if (!quarter || !year) {
      hint.textContent = "Нужен квартал и год.";
      return;
    }
    const range = getQuarterRange(year, quarter);
    dateFrom = range.beginTime;
    dateTo = range.endTime;
  } else if (!dateFrom || !dateTo) {
    hint.textContent = "Нужны даты начала/конца.";
    return;
  }

  clearResults();
  hint.textContent = "Запрос данных отчета...";
  setBusy(true);
  startCooldown(60);

  try {
    const result = await fetchReportDetailByPeriodPaged(
      credential,
      dateFrom,
      dateTo,
      (payload) => {
        if (payload.phase === "cooldown") {
          hint.textContent = `Ожидание лимита WB: ${payload.remaining}с`;
          return;
        }
        hint.textContent = `Загрузка данных... пакетов: ${payload.batch}, строк: ${payload.total}`;
      },
    );
    const rows = result.rows;

    if (!rows.length) {
      renderDiagnostics(["Ошибка: Пустой ответ API за выбранный период."]);
      throw new Error("Пустой ответ API за выбранный период.");
    }

    const summary = calculateTaxBase(rows.map(normalizeReportRow), dateTo);
    state.lastSummary = summary;
    renderResults(summary);
    hint.textContent = `Готово. Период: ${dateFrom} → ${dateTo}.`;
  } catch (err) {
    hint.textContent = `Ошибка: ${extractErrorDetail(err)}`;
  } finally {
    setBusy(false);
  }
}

el("fetch").addEventListener("click", fetchAndCompute);
el("auth").addEventListener("click", authorize);
el("account-select").addEventListener("change", selectAccount);
el("remove-account").addEventListener("click", removeActiveAccount);
el("period-mode").addEventListener("change", updatePeriodMode);

window.addEventListener("error", (event) => {
  const diag = el("diagnostics");
  diag.textContent = `Ошибка приложения: ${event.message}`;
});

document.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

document.addEventListener("selectstart", (event) => {
  if (event.target && event.target.tagName === "INPUT") return;
  event.preventDefault();
});

updatePeriodMode();
loadAccounts().then(() => {
  state.activeAccountId = state.accounts[0]?.id || null;
  renderAccounts();
}).catch((err) => {
  el("auth-result").textContent = "Не удалось открыть кабинеты: " + extractErrorDetail(err);
  el("auth-result").style.display = "block";
  renderAccounts();
});

el("token").addEventListener("input", () => {
  if (isBrowserHosted) {
    setAuthorized(Boolean(activeAccount()?.hasToken || el("token").value.trim()));
    clearResults();
  } else if (el("token").value !== activeAccount()?.token) {
    setAuthorized(false);
    clearResults();
  } else {
    setAuthorized(Boolean(activeAccount()?.token));
  }
});
