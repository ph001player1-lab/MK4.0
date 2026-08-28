// "Захвати рынок или закрой бизнес" — MVP v4.4 · от 28.08.2026
// Табло для проектора/ТВ. Обращается к Code.gs через fetch() (только GET).

// ⚠️ Та же ссылка, что и в App.js. Меняется в двух местах при новом деплое.
// Те же два значения, что и в App.js. Заполняются один раз.
var EXEC_URL = 'https://xgojmizawllcfbfojbex.supabase.co/functions/v1/game';
var SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhnb2ptaXphd2xsY2ZiZm9qYmV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc4OTU5NTksImV4cCI6MjEwMzQ3MTk1OX0.X9yCnRspwyFtbd-kzP152WVFfttIzdHDjH3i10fUTfU';

var METRIC_LABELS = {
  profit: 'Прибыль / доход за месяц, ฿',
  cash: 'Капитал: касса или накопления, ฿',
  marketSharePct: 'Доля рынка, %',
  served: 'Обслужено клиентов',
  price: 'Цена, ฿',
  brand: 'Бренд',
  reputation: 'Репутация',
  quality: 'Качество',
  capacity: 'Ёмкость (пропускная способность)',
  marketingTotal: 'Расходы на рекламу, ฿',
  qualityInvest: 'Расходы на качество, ฿'
};

// v3.3. Две метрики есть у КАЖДОГО игрока, независимо от того, ведёт он
// бизнес или нет: сколько у него денег и сколько пришло за месяц.
// Госслужба платит зарплату, работодатель платит наёмному, другие игроки
// шлют переводы — это реальные деньги, и на табло за ними надо следить
// наравне со всеми. Остальные метрики — игровые переменные заведения
// (доля рынка, клиенты, цена, бренд, репутация, качество, ёмкость,
// рекламные бюджеты); у человека без заведения их не существует, и там
// линия честно рвётся, а не рисует ноль, которого нет.
var WALLET_METRICS = { cash: true, profit: true };

var PALETTE = [
  '#3ba55d', '#5b8def', '#e0a530', '#d9534f', '#9b59b6', '#1abc9c',
  '#e67e22', '#2ecc71', '#e74c3c', '#3498db', '#f1c40f', '#95a5a6'
];

var currentMetric = 'profit';
var chart = null;
var lastTimeline = null;
var tabloCountdownInterval = null;
var tabloDeadlineMs = null;

var DEFAULT_EMPTY_TEXT = 'Пока нет данных — табло обновится, как только будет рассчитан первый месяц.';

// Изредка Apps Script на долю секунды отдаёт HTML-заглушку вместо JSON —
// особенно заметно при игре через VPN с меняющейся страной выхода (разные
// запросы попадают на разные edge-узлы Google). Само проходит за 10-20
// секунд, поэтому вместо немедленной ошибки делаем несколько попыток с
// паузой — табло и так обновляется раз в 10 сек, задержка почти незаметна.
var FETCH_RETRY_ATTEMPTS = 4;
var FETCH_RETRY_DELAY_MS = 4000;

function delay_(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function attemptFetchJson_(url) {
  return fetch(url, {
    cache: 'no-store',
    headers: { Authorization: 'Bearer ' + SUPABASE_KEY, apikey: SUPABASE_KEY }
  }).then(function (response) {
    return response.text().then(function (text) {
      try {
        return JSON.parse(text);
      } catch (e) {
        var snippet = text.slice(0, 300).replace(/\s+/g, ' ').trim();
        throw new Error('сервер вернул не JSON (код ' + response.status + '): ' + snippet);
      }
    });
  });
}

function fetchJsonWithRetry_(url, attemptsLeft) {
  if (attemptsLeft === undefined) attemptsLeft = FETCH_RETRY_ATTEMPTS;
  return attemptFetchJson_(url).catch(function (err) {
    if (attemptsLeft > 1) {
      return delay_(FETCH_RETRY_DELAY_MS).then(function () {
        return fetchJsonWithRetry_(url, attemptsLeft - 1);
      });
    }
    throw err;
  });
}

function apiGet(action) {
  if (!EXEC_URL || EXEC_URL.indexOf('ВСТАВЬТЕ') !== -1) {
    return Promise.reject(new Error('EXEC_URL не задан — вставьте адрес Edge Function в tablo.js.'));
  }
  // Табло висит часами на одном экране — без обхода кэша оно рискует
  // замереть на давно неактуальной картинке.
  return fetchJsonWithRetry_(EXEC_URL + '?action=' + encodeURIComponent(action) +
    '&_ts=' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
}

function showTabloMessage(text) {
  var empty = document.getElementById('tablo-empty');
  var canvas = document.getElementById('tablo-chart');
  empty.textContent = text;
  empty.classList.remove('hidden');
  canvas.classList.add('hidden');
}

function loadTimeline() {
  apiGet('timeline')
    .then(function (d) {
      if (!d.ok) {
        // Раньше эта ветка молча ничего не делала — из-за этого при ошибке
        // на сервере (например, если руками стёрли данные из Rounds) табло
        // показывало пустой холст без единого объяснения. Теперь видно, в чём дело.
        showTabloMessage('Ошибка на сервере: ' + (d.error || 'неизвестная ошибка') +
          '. Проверьте Config → ADMIN_USERNAME и структуру листов (запустите setupSheets() ещё раз).');
        return;
      }
      lastTimeline = d;
      document.getElementById('t-round').textContent = 'Месяц ' + d.roundNumber +
        (d.totalRounds ? ' из ' + d.totalRounds : '');
      startTabloCountdown(d.roundStatus === 'open' ? d.deadline : null);
      renderChart();
    })
    .catch(function (err) {
      showTabloMessage('Не удалось связаться с сервером: ' + err.message);
    });
}

function startTabloCountdown(deadlineIso) {
  if (tabloCountdownInterval) { clearInterval(tabloCountdownInterval); tabloCountdownInterval = null; }
  var el = document.getElementById('t-timer');
  if (!deadlineIso) { el.classList.add('hidden'); return; }

  tabloDeadlineMs = new Date(deadlineIso).getTime();
  tick();
  tabloCountdownInterval = setInterval(tick, 1000);

  function tick() {
    var remaining = Math.max(0, Math.round((tabloDeadlineMs - Date.now()) / 1000));
    var mm = String(Math.floor(remaining / 60)).padStart(2, '0');
    var ss = String(remaining % 60).padStart(2, '0');
    el.textContent = mm + ':' + ss;
    el.classList.remove('hidden');
    el.classList.toggle('timer-urgent', remaining <= 30);
    if (remaining <= 0) { clearInterval(tabloCountdownInterval); tabloCountdownInterval = null; }
  }
}

function renderChart() {
  var empty = document.getElementById('tablo-empty');
  var canvas = document.getElementById('tablo-chart');
  var techPage = document.getElementById('tablo-techinfo');
  var treasuryPage = document.getElementById('tablo-treasury');
  if (treasuryPage) treasuryPage.classList.add('hidden');

  if (currentMetric === 'treasury') {
    if (chart) { chart.destroy(); chart = null; }
    canvas.classList.add('hidden');
    techPage.classList.add('hidden');
    renderTreasuryPage();
    return;
  }

  if (currentMetric === 'techinfo') {
    canvas.classList.add('hidden');
    renderTechInfoPage();
    return;
  }
  techPage.classList.add('hidden');

  if (!lastTimeline) return;

  if (typeof Chart === 'undefined') {
    // Отдельная, честная причина: библиотека графиков не загрузилась
    // (например, CDN недоступен или версия не найдена) — это НЕ ошибка
    // сервера и НЕ повод писать "не удалось связаться с сервером".
    showTabloMessage('Не загрузилась библиотека графиков (Chart.js). Проверьте интернет-соединение на этом экране и обновите страницу.');
    return;
  }

  var hasData = lastTimeline.players.some(function (p) { return p.series.length > 0; });
  if (!hasData) {
    empty.textContent = DEFAULT_EMPTY_TEXT;
    empty.classList.remove('hidden');
    canvas.classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');
  canvas.classList.remove('hidden');

  var allRounds = new Set();
  lastTimeline.players.forEach(function (p) {
    p.series.forEach(function (pt) { allRounds.add(pt.round); });
  });
  var rounds = Array.from(allRounds).sort(function (a, b) { return a - b; });
  var labels = rounds.map(function (r) { return 'Мес. ' + r; });

  // Разный штрих и размер точек по кругу (не только цвет) — если у двух
  // игроков значения метрики совпали пиксель в пиксель (например, оба
  // упёрлись в один и тот же зажим формулы), линии всё равно должны
  // оставаться различимы, а не сливаться в одну на глаз.
  var DASH_PATTERNS = [[], [10, 5], [2, 3], [14, 4, 2, 4]];
  var POINT_RADII = [4, 6, 4, 6];
  var POINT_STYLES = ['circle', 'rectRot', 'triangle', 'rect'];

  var anyGaps = false;
  var anyOffBusinessPoints = false;

  var datasets = lastTimeline.players.map(function (p, i) {
    var byRound = {}, inBusinessByRound = {};
    p.series.forEach(function (pt) {
      byRound[pt.round] = pt[currentMetric];
      inBusinessByRound[pt.round] = pt.inBusiness !== false;
    });

    var data = rounds.map(function (r) {
      var v = byRound.hasOwnProperty(r) ? byRound[r] : null;
      return (v === undefined) ? null : v;
    });
    if (data.some(function (v) { return v === null; })) anyGaps = true;

    var baseRadius = POINT_RADII[i % POINT_RADII.length];
    var baseStyle = POINT_STYLES[i % POINT_STYLES.length];

    // На вкладках «Капитал» и «Прибыль / доход» точки вне бизнеса рисуем
    // крестиком: линия непрерывна (деньги-то никуда не делись), но сразу
    // видно, что в этот месяц человек не торговал, а получал зарплату
    // или жил на переводы.
    var pointStyle = baseStyle, pointRadius = baseRadius;
    if (WALLET_METRICS[currentMetric]) {
      pointStyle = rounds.map(function (r) {
        if (data[rounds.indexOf(r)] === null) return baseStyle;
        if (inBusinessByRound[r] === false) { anyOffBusinessPoints = true; return 'crossRot'; }
        return baseStyle;
      });
      pointRadius = rounds.map(function (r) {
        return inBusinessByRound[r] === false ? baseRadius + 2 : baseRadius;
      });
    }

    var color = PALETTE[i % PALETTE.length];
    return {
      label: p.restaurant + (p.inBusiness === false ? ' · вне бизнеса' : ''),
      data: data,
      borderColor: color,
      backgroundColor: color,
      borderWidth: 3,
      borderDash: DASH_PATTERNS[i % DASH_PATTERNS.length],
      pointRadius: pointRadius,
      pointStyle: pointStyle,
      tension: 0.25,

      // v3.2 — ГЛАВНЫЙ ФИКС ТАБЛО, актуален для игровых метрик заведения.
      // Там, где у игрока нет данных (нет заведения — нет доли рынка,
      // клиентов, бренда), стоит null. С spanGaps: true график ПРОТЯГИВАЛ
      // сквозь эти null прямую линию, и на проекторе это читалось как
      // «у него всё это время была прибыль и была доля рынка». Точек не
      // было, но линию на большом экране видно, а точки — нет.
      //
      // v3.3: для «Капитала» и «Прибыли / дохода» разрывов больше нет в
      // принципе — эти данные теперь есть у всех и за все месяцы (см.
      // журнал Wallets в Code.gs). Разрывы остались только там, где им и
      // место: на метриках, которых у человека без бизнеса не существует.
      spanGaps: false
    };
  });

  var subtitleText = '';
  if (WALLET_METRICS[currentMetric] && anyOffBusinessPoints) {
    subtitleText = 'Крестики — месяцы вне бизнеса: показан кошелёк (зарплата госслужбы, выплаты нанимателя, переводы).';
  } else if (anyGaps) {
    subtitleText = 'Разрыв линии — месяцы без заведения: доли рынка, клиентов и бренда у игрока в это время не существует.';
  }

  var ctx = canvas.getContext('2d');
  if (chart) chart.destroy();
  try {
    chart = new Chart(ctx, {
      type: 'line',
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 400 },
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: '#eef0f3', font: { size: 16 }, boxWidth: 20 }
          },
          title: {
            display: true, text: METRIC_LABELS[currentMetric],
            color: '#eef0f3', font: { size: 22, weight: '600' }, padding: { bottom: 4 }
          },
          // Пояснение под заголовком зависит от того, что сейчас на
          // экране: на денежных вкладках объясняем крестики, на игровых —
          // разрывы. Если ни того, ни другого нет — места не занимаем.
          subtitle: {
            display: !!subtitleText, text: subtitleText,
            color: '#8a8f99', font: { size: 14 }, padding: { bottom: 14 }
          }
        },
        scales: {
          x: { ticks: { color: '#8a8f99', font: { size: 14 } }, grid: { color: '#262a33' } },
          y: { ticks: { color: '#8a8f99', font: { size: 14 } }, grid: { color: '#262a33' } }
        }
      }
    });
  } catch (err) {
    showTabloMessage('Ошибка отрисовки графика: ' + err.message);
  }
}


// ==================== ВКЛАДКА «КАЗНА» (v4.4) ====================
//
// Государство здесь не бездонный карман: аренда и проценты по кредитам
// наполняют казну, штрафы пополняют, субсидии и зарплаты госслужащих
// расходуют. Показываем это всем — тогда решение ведущего выдать
// субсидию становится видимым выбором, а не жестом из ниоткуда.

var treasuryIncomeChart = null;
var treasuryBalanceChart = null;

function destroyTreasuryCharts() {
  if (treasuryIncomeChart) { treasuryIncomeChart.destroy(); treasuryIncomeChart = null; }
  if (treasuryBalanceChart) { treasuryBalanceChart.destroy(); treasuryBalanceChart = null; }
}

function treasuryAxes(withZeroLine) {
  return {
    x: { ticks: { color: '#aab0bb', font: { size: 15 } }, grid: { color: '#20242c' } },
    y: {
      ticks: {
        color: '#aab0bb', font: { size: 15 },
        callback: function (v) { return Number(v).toLocaleString('ru-RU'); }
      },
      grid: { color: withZeroLine ? '#2c313b' : '#20242c' }
    }
  };
}

function renderTreasuryPage() {
  var page = document.getElementById('tablo-treasury');
  var empty = document.getElementById('tablo-empty');
  var rows = lastTimeline && lastTimeline.treasury;

  if (!rows || !rows.length) {
    destroyTreasuryCharts();
    empty.textContent = 'Казна пополнится после расчёта первого месяца.';
    empty.classList.remove('hidden');
    page.classList.add('hidden');
    return;
  }

  empty.classList.add('hidden');
  page.classList.remove('hidden');

  var labels = rows.map(function (r) { return 'Мес ' + r.round; });
  var last = rows[rows.length - 1];

  var fmt = function (v) { return Number(v).toLocaleString('ru-RU') + ' ฿'; };
  document.getElementById('treasury-summary').innerHTML =
    '<div class="treasury-stat"><div class="treasury-stat-label">Казна сейчас</div>' +
      '<div class="treasury-stat-value' + (last.balance < 0 ? ' negative' : '') + '">' + fmt(last.balance) + '</div></div>' +
    '<div class="treasury-stat"><div class="treasury-stat-label">За последний месяц</div>' +
      '<div class="treasury-stat-value' + (last.income < 0 ? ' negative' : '') + '">' + fmt(last.income) + '</div></div>' +
    '<div class="treasury-stat"><div class="treasury-stat-label">Аренда за месяц</div>' +
      '<div class="treasury-stat-value">' + fmt(last.rent) + '</div></div>' +
    '<div class="treasury-stat"><div class="treasury-stat-label">Проценты банку</div>' +
      '<div class="treasury-stat-value">' + fmt(last.interest) + '</div></div>' +
    '<div class="treasury-stat"><div class="treasury-stat-label">Штрафы собрано</div>' +
      '<div class="treasury-stat-value">' + fmt(last.fines) + '</div></div>' +
    '<div class="treasury-stat"><div class="treasury-stat-label">Выплачено из казны</div>' +
      '<div class="treasury-stat-value negative">' + fmt(last.subsidies) + '</div></div>';

  destroyTreasuryCharts();

  // График 1: из чего сложился доход месяца. Столбики с накоплением —
  // сразу видно вклад каждого источника, а не только итог.
  treasuryIncomeChart = new Chart(document.getElementById('treasury-income-chart').getContext('2d'), {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        { label: 'Аренда', data: rows.map(function (r) { return r.rent; }), backgroundColor: '#3ba55d' },
        { label: 'Проценты', data: rows.map(function (r) { return r.interest; }), backgroundColor: '#5b8ff9' },
        { label: 'Штрафы', data: rows.map(function (r) { return r.fines; }), backgroundColor: '#e0a530' },
        { label: 'Выплаты из казны', data: rows.map(function (r) { return -r.subsidies; }), backgroundColor: '#d9534f' }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#eef0f3', font: { size: 15 } } } },
      scales: {
        x: Object.assign({ stacked: true }, treasuryAxes(true).x),
        y: Object.assign({ stacked: true }, treasuryAxes(true).y)
      }
    }
  });

  // График 2: накопленная казна нарастающим итогом.
  treasuryBalanceChart = new Chart(document.getElementById('treasury-balance-chart').getContext('2d'), {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Казна',
        data: rows.map(function (r) { return r.balance; }),
        borderColor: '#3ba55d', backgroundColor: 'rgba(59,165,93,0.15)',
        borderWidth: 4, tension: 0.25, fill: true, pointRadius: 5
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: treasuryAxes(true)
    }
  });
}

function renderTechInfoPage() {
  var page = document.getElementById('tablo-techinfo');
  var empty = document.getElementById('tablo-empty');
  var info = lastTimeline && lastTimeline.techInfo;

  if (!info) {
    empty.textContent = DEFAULT_EMPTY_TEXT;
    empty.classList.remove('hidden');
    page.classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');
  page.classList.remove('hidden');

  function item(label, value, small) {
    return '<div class="techinfo-item"><div class="techinfo-label">' + label + '</div>' +
      '<div class="techinfo-value">' + value + (small ? ' <small>' + small + '</small>' : '') + '</div></div>';
  }

  var html = '<div class="techinfo-title">Технические данные (общие для всех)</div><div class="techinfo-grid">';
  html += item('Игроков', info.playersCount);
  html += item('Всего клиентов на рынке в этом месяце', info.currentMarketTotal !== null ? info.currentMarketTotal.toLocaleString('ru-RU') : '—');
  html += item('Референсная цена', info.pRef.thb.toLocaleString('ru-RU') + ' ฿');
  html += item('Базовая себестоимость блюда', info.cogsBase.thb.toLocaleString('ru-RU') + ' ฿', 'растёт с качеством');
  html += item('Аренда', info.rent.thb.toLocaleString('ru-RU') + ' ฿/мес');
  html += item('ФОТ', info.payroll.thb.toLocaleString('ru-RU') + ' ฿/мес');
  html += item('Базовая ёмкость', info.capacityBase.toLocaleString('ru-RU'), 'шаг смены: ' + info.capacityStep.toLocaleString('ru-RU'));
  html += item('Стартовый капитал', info.startCapital.thb.toLocaleString('ru-RU') + ' ฿');
  html += item('Ставка банка', Math.round(info.loanRateAnnual * 100) + '%');
  html += item('Раунд / партия', info.roundDurationMin + ' мин', info.totalRounds + ' мес.');
  html += '</div>';

  if (info.marketing) {
    var mk = info.marketing;
    html += '<div class="techinfo-title" style="margin-top:22px;">Маркетинговые каналы, которые привлекают клиентов</div>';
    html += '<div class="techinfo-explainer">' +
      'Представьте, что каждый канал — это отдельный человек, которого вы наняли рассказывать людям про ваш ресторан.<br><br>' +
      '<b>Альфа</b> — насколько убедителен именно этот человек: дайте ему денег на рекламу — и кто-то (высокая альфа) ' +
      'уговорит гораздо больше людей, чем другой с тем же бюджетом (низкая альфа). Это про то, как хорошо деньги ' +
      'превращаются в результат — но только внутри своего канала, само по себе.<br><br>' +
      '<b>Вес</b> — насколько вообще важно клиенту то, что говорит именно этот канал, когда он выбирает, куда пойти ' +
      'поесть. Даже самый убедительный человек не поможет, если люди в принципе не обращают внимания на такую рекламу.<br><br>' +
      '<i>Пример:</i> у SEO альфа = 0.9, вес = 0.5. При опорном бюджете SEO «внутри себя» выдаёт эффект силой 0.9, ' +
      'но на итоговую привлекательность заведения это повлияет как 0.9 × 0.5 ≈ 0.45 — вес срезает часть эффекта, ' +
      'потому что не все клиенты смотрят на позиции в поиске перед выбором ресторана.<br><br>' +
      '<b>А если вложить больше опорного бюджета?</b> Эффект растёт не пропорционально деньгам, а гораздо медленнее — ' +
      'как квадратный корень из того, во сколько раз бюджет больше опорного. Это и есть «убывающая отдача»: заливать ' +
      'один канал деньгами сверх меры — плохая стратегия.' +
      '</div>';
    html += '<table class="techinfo-scale-table"><thead><tr><th>Вложили</th><th>Во сколько раз вырос эффект</th></tr></thead><tbody>' +
      '<tr><td>1× опорный бюджет</td><td>×1.00</td></tr>' +
      '<tr><td>2× опорный бюджет</td><td>×1.41</td></tr>' +
      '<tr><td>3× опорный бюджет</td><td>×1.73</td></tr>' +
      '<tr><td>5× опорный бюджет</td><td>×2.24</td></tr>' +
      '<tr><td>10× опорный бюджет</td><td>×3.16</td></tr>' +
      '</tbody></table>';
    html += '<div class="techinfo-explainer">Вложили вдвое больше — эффект вырос не вдвое, а всего в ~1.4 раза. ' +
      'А чтобы <b>удвоить сам эффект</b>, нужно вложить не в 2, а <b>в 4 раза больше</b> опорного бюджета. Каждое ' +
      'следующее удвоение результата обходится всё дороже — поэтому после определённого момента выгоднее не заливать ' +
      'один канал ещё сильнее, а переключиться на другой канал, качество или цену.</div>';

    html += '<div class="techinfo-grid">';
    html += item('SEO', 'вес ' + mk.seo.weight, 'альфа ' + mk.seo.alpha + ' · опорный бюджет ' + mk.seo.refBudget.thb.toLocaleString('ru-RU') + ' ฿ · разгон ' + mk.seo.rampMonths + ' мес. · затухание ' + mk.seo.decay);
    html += item('Промоутеры', 'вес ' + mk.promo.weight, 'альфа ' + mk.promo.alpha + ' · опорный бюджет ' + mk.promo.refBudget.thb.toLocaleString('ru-RU') + ' ฿');
    html += item('Google Карты', 'вес ' + mk.maps.weight, 'альфа ' + mk.maps.alpha + ' · опорный бюджет ' + mk.maps.refBudget.thb.toLocaleString('ru-RU') + ' ฿ · затухание ' + mk.maps.decay);
    html += item('Соцсети', 'вес ' + mk.social.weight, 'альфа ' + mk.social.alpha + ' · опорный бюджет ' + mk.social.refBudget.thb.toLocaleString('ru-RU') + ' ฿ · затухание ' + mk.social.decay);
    html += item('Наружная реклама', 'вес ' + mk.outdoor.weight, 'альфа ' + mk.outdoor.alpha + ' · опорный бюджет ' + mk.outdoor.refBudget.thb.toLocaleString('ru-RU') + ' ฿ · мин. взнос ' + mk.outdoor.minSpend.thb.toLocaleString('ru-RU') + ' ฿ · срок ' + mk.outdoor.durationMonths + ' мес.');
    html += '</div>';
  }

  if (info.quality) {
    var q = info.quality;
    var investExample = Math.round(q.investDivisor.thb / 2);
    html += '<div class="techinfo-title" style="margin-top:22px;">Качество</div>';
    html += '<div class="techinfo-explainer">' +
      'Качество работает не как каналы рекламы — тут нет альфы и убывающей отдачи, правило простое и линейное: ' +
      'сколько бат вложили, ровно настолько (по фиксированному курсу) выросло качество.<br><br>' +
      '<i>Пример:</i> сейчас курс — ' + q.investDivisor.thb.toLocaleString('ru-RU') + ' ฿ вложений дают +1 единицу ' +
      'качества. Вложили ' + investExample.toLocaleString('ru-RU') + ' ฿ разово — качество выросло на +0.5.<br><br>' +
      'Дальше качество влияет на привлекательность заведения точно так же, как и каналы рекламы — через свой вес ' +
      '(сейчас ' + q.weight + '). Но у качества есть три особенности, которых нет у рекламы: оно повышает ' +
      'себестоимость блюда (сейчас +' + Math.round(q.cogsAdd * 100) + '% к базовой себестоимости за каждую единицу ' +
      'качества — готовить хорошо стоит дороже), требует ежемесячных трат на поддержание (сейчас ' +
      q.upkeep.thb.toLocaleString('ru-RU') + ' ฿/мес за каждую единицу — просто «стоять на месте» тоже стоит денег), ' +
      'и без новых вложений медленно падает каждый месяц (сейчас на ' + Math.round(q.decay * 100) + '%) — один раз ' +
      'вложились и забыли не получится.' +
      '</div>';
  }

  if (info.marketing && info.marketing.affiliate) {
    var aff = info.marketing.affiliate;
    html += '<div class="techinfo-title" style="margin-top:22px;">Партнёрская программа</div>';
    html += '<div class="techinfo-explainer">' +
      'Устроена совсем не так, как остальные каналы — она вообще не влияет на то, сколько клиентов к вам придёт. ' +
      'Это надбавка к чеку с уже пришедших клиентов, а не способ привлечь новых.<br><br>' +
      'Правило простое, без всякой убывающей отдачи: платите ≥ минимального взноса (сейчас ' +
      aff.minSpend.thb.toLocaleString('ru-RU') + ' ฿/мес) — вся выручка месяца увеличивается на фиксированный ' +
      'процент (сейчас +' + Math.round(aff.bonusPct * 100) + '%). Не платите — бонус просто выключен.<br><br>' +
      '<i>Пример:</i> заплатить сверх минимума бесполезно — бонус не растёт от переплаты. ' +
      aff.minSpend.thb.toLocaleString('ru-RU') + ' ฿ и ' + (aff.minSpend.thb * 10).toLocaleString('ru-RU') +
      ' ฿ дадут одинаковые +' + Math.round(aff.bonusPct * 100) + '%, разница просто улетит в никуда.' +
      '</div>';
    html += '<div class="techinfo-grid">';
    html += item('Партнёрская программа', '+' + Math.round(aff.bonusPct * 100) + '% к выручке', 'мин. ежемесячный взнос ' + aff.minSpend.thb.toLocaleString('ru-RU') + ' ฿');
    html += '</div>';
  }

  page.innerHTML = html;
}

document.querySelectorAll('.tab-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    document.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
    btn.classList.add('active');
    currentMetric = btn.getAttribute('data-metric');
    renderChart();
  });
});

loadTimeline();
setInterval(loadTimeline, 10000); // табло само обновляется по мере расчёта месяцев
