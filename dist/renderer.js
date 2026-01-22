const wbApi =
  window.wbApi ||
  (() => {
    const invoke =
      window.__TAURI__?.core?.invoke || window.__TAURI__?.tauri?.invoke;
    if (!invoke) {
      console.error("Tauri invoke unavailable");
      return null;
    }

    return {
      reportDetailByPeriod: (params) =>
        invoke("report_detail_by_period", params),
      sellerInfo: (params) => invoke("seller_info", params),
    };
  })();

const state = {
  lastSummary: null,
  authorized: false,
  busy: false,
};

const el = (id) => document.getElementById(id);
const STORAGE_KEY = "wb-tax-base-token";

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

function saveToken(token) {
  try {
    localStorage.setItem(STORAGE_KEY, token || "");
  } catch (_err) {
    // ignore storage errors
  }
}

function loadToken() {
  try {
    return localStorage.getItem(STORAGE_KEY) || "";
  } catch (_err) {
    return "";
  }
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
  ["period-mode", "quarter", "year", "date-from", "date-to", "fetch"].forEach(
    (id) => {
      const node = el(id);
      if (node) node.disabled = !isAuthorized || state.busy;
    },
  );
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
  token,
  dateFrom,
  dateTo,
  onProgress,
) {
  const limit = 50000;
  let rrdid = 0;
  let all = [];
  let batch = 0;
  let lastRrdId = 0;

  while (true) {
    const rows = await wbApi.reportDetailByPeriod({
      token,
      dateFrom,
      dateTo,
      limit,
      rrdid,
      period: "daily",
    });

    if (!Array.isArray(rows) || rows.length === 0) {
      break;
    }

    all = all.concat(rows);
    batch += 1;
    if (onProgress) onProgress({ batch, total: all.length });

    const last = rows[rows.length - 1];
    const nextRrdId = last?.rrd_id ?? last?.rrdId ?? last?.rrdid;
    if (!nextRrdId || nextRrdId === rrdid) {
      lastRrdId = nextRrdId || rrdid;
      break;
    }
    rrdid = nextRrdId;
    lastRrdId = nextRrdId;
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
  if (!wbApi) {
    const authEl = el("auth-result");
    authEl.textContent = "Tauri API недоступен. Перезапустите приложение.";
    authEl.style.display = "block";
    return;
  }
  const token = el("token").value.trim();
  const authEl = el("auth-result");
  if (!token) {
    authEl.textContent = "Нужен токен для авторизации.";
    return;
  }
  authEl.textContent = "Запрос профиля...";
  authEl.style.display = "block";
  try {
    const info = await wbApi.sellerInfo({ token });
    if (!info) {
      authEl.textContent = "Пустой ответ seller-info.";
      setAuthorized(false);
      return;
    }
    renderAuth(info);
    setAuthorized(true);
    saveToken(token);
  } catch (err) {
    authEl.textContent = `Ошибка авторизации: ${err.message}`;
    setAuthorized(false);
  }
}

function setBusy(isBusy) {
  state.busy = isBusy;
  ["period-mode", "quarter", "year", "date-from", "date-to", "fetch"].forEach(
    (id) => {
      const node = el(id);
      if (node) node.disabled = !state.authorized || isBusy;
    },
  );
  const sourcesCard = el("sources-card");
  if (sourcesCard)
    sourcesCard.classList.toggle("is-disabled", !state.authorized || isBusy);
  const overlay = el("results-overlay");
  if (overlay) overlay.classList.toggle("is-visible", isBusy);
}

async function fetchAndCompute() {
  if (!wbApi) {
    el("fetch-hint").textContent =
      "Tauri API недоступен. Перезапустите приложение.";
    return;
  }

  const token = el("token").value.trim();
  const mode = el("period-mode").value;
  const dateFromInput = el("date-from").value;
  const dateToInput = el("date-to").value;
  const quarter = el("quarter").value;
  const year = el("year").value;
  const hint = el("fetch-hint");

  if (!token) {
    hint.textContent = "Нужен токен.";
    return;
  }
  if (!state.authorized) {
    hint.textContent = "Сначала выполните авторизацию.";
    return;
  }

  saveToken(token);

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

  try {
    const result = await fetchReportDetailByPeriodPaged(
      token,
      dateFrom,
      dateTo,
      ({ batch, total }) => {
        hint.textContent = `Загрузка данных... пакетов: ${batch}, строк: ${total}`;
      },
    );
    const rows = result.rows;

    if (!rows.length) {
      renderDiagnostics(["Ошибка: Пустой ответ API за выбранный период."]);
      throw new Error("Пустой ответ API за выбранный период.");
    }

    const summary = calculateTaxBase(rows, dateTo);
    state.lastSummary = summary;
    renderResults(summary);
    hint.textContent = `Готово. Период: ${dateFrom} → ${dateTo}.`;
    saveToken(token);
  } catch (err) {
    hint.textContent = `Ошибка: ${err.message}`;
  } finally {
    setBusy(false);
  }
}

el("fetch").addEventListener("click", fetchAndCompute);
el("auth").addEventListener("click", authorize);
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

const savedToken = loadToken();
if (savedToken) el("token").value = savedToken;
updatePeriodMode();
setAuthorized(false);
renderAuth(null);

el("token").addEventListener("change", () => {
  saveToken(el("token").value);
  setAuthorized(false);
  renderAuth(null);
  clearResults();
});
