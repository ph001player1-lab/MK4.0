// "Захвати рынок или закрой бизнес" — MVP v4.0 · от 28.08.2026
// Кабинет игрока и администратора. Обращается к Code.gs через fetch()
// (только GET — см. пояснение внутри apiPost ниже).

// ------------------------------------------------------------ НАСТРОЙКА API

// ⚠️ Два значения, которые нужно подставить один раз.
//
// EXEC_URL — адрес Edge Function в Supabase, вида
//   https://ВАШ-ПРОЕКТ.supabase.co/functions/v1/game
// SUPABASE_KEY — публичный ключ (publishable / anon) из Project Settings.
//
// Публичный ключ НЕ секрет: он по замыслу уезжает в браузер каждому
// игроку. Красть им нечего — RLS в базе запрещает этому ключу всё, а
// решает, кому что показать, сама Edge Function.
var EXEC_URL = 'https://xgojmizawllcfbojbex.supabase.co/functions/v1/game';
var SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhnb2ptaXphd2xsY2ZiZm9qYmV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc4OTU5NTksImV4cCI6MjEwMzQ3MTk1OX0.X9yCnRspwyFtbd-kzP152WVFfttIzdHDjH3i10fUTfU';

// Изредка Apps Script (через распределённую сеть edge-узлов Google) на
// долю секунды отдаёт HTML-заглушку вместо JSON — особенно заметно при
// игре через VPN с меняющейся страной выхода, когда разные запросы
// попадают на разные узлы. Судя по наблюдениям, само проходит за 10-20
// секунд, поэтому вместо немедленной ошибки делаем несколько попыток с
// паузой — тогда сбой чаще всего проглатывается незаметно для игрока
// (кнопки и так блокируются минимум на 10 сек — см. withButtonLoading).
// v4.0. На Apps Script приходилось ждать по 4 секунды между попытками:
// его edge-узлы могли отдавать HTML вместо JSON по 10-20 секунд подряд.
// Supabase так себя не ведёт, поэтому паузы короче — сбой на плохой
// связи теперь переживается за секунды, а не за полминуты.
var FETCH_RETRY_ATTEMPTS = 3;
var FETCH_RETRY_DELAY_MS = 1200;

function delay_(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function attemptFetchJson_(url) {
  // v3.3. cache: 'no-store' + уникальный параметр _ts в каждом URL.
  // Все запросы (включая записывающие) идут через GET, а GET-ответы
  // Apps Script браузер вполне может отдать из кэша — тогда сразу после
  // действия приходит СТАРОЕ состояние, и кажется, что «не применилось».
  // Уникальный параметр гарантирует, что каждый запрос уходит на сервер.
  // Edge Function закрыта шлюзом Supabase: без заголовка авторизации
  // запрос до нашего кода просто не доходит.
  return fetch(url, {
    cache: 'no-store',
    headers: { Authorization: 'Bearer ' + SUPABASE_KEY, apikey: SUPABASE_KEY }
  }).then(function (response) {
    return response.text().then(function (text) {
      try {
        return JSON.parse(text);
      } catch (e) {
        // Раньше при не-JSON ответе (HTML-страница ошибки от Google)
        // сообщение было криптичным ("Unexpected token '<'..."), не
        // показывающим, что реально пришло. Теперь показываем начало
        // настоящего ответа и код статуса — единственный способ отличить
        // "устаревший деплой", "требуется авторизация", временный сбой
        // edge-узла и т.п. друг от друга, если все попытки исчерпаны.
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

function apiGet(action, params) {
  if (!EXEC_URL || EXEC_URL.indexOf('ВСТАВЬТЕ') !== -1) {
    return Promise.reject(new Error('EXEC_URL не задан — вставьте ссылку на ваш деплой Apps Script в App.js.'));
  }
  var url = EXEC_URL + '?action=' + encodeURIComponent(action);
  Object.keys(params || {}).forEach(function (k) {
    url += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  });
  url += impersonationSuffix_();
  url += '&_ts=' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  return fetchJsonWithRetry_(url);
}

// ------------------------------------------------------- ЗАЩИТА ОТ УСТАРЕВШИХ ОТВЕТОВ (v3.2)
//
// Кабинет опрашивает сервер каждые 8 секунд отдельным независимым
// запросом. Если в момент нажатия кнопки («Одобрить»/«Отклонить», смена
// деятельности, выплата зарплаты) уже находится «в полёте» предыдущий
// фоновый опрос, начавшийся чуть раньше, то его УСТАРЕВШИЙ ответ может
// прилететь уже ПОСЛЕ вашего действия и перерисовать экран старым
// состоянием. Особенно легко это ловится из-за автоповтора на сетевых
// сбоях (FETCH_RETRY_*): сбойнувший опрос может идти 12+ секунд и
// приземлиться заведомо позже свежего действия. Наружу это выглядело
// так: нажал «Одобрить», через 8 секунд снова видишь кнопки выбора,
// хотя на сервере уже всё одобрено, и только через пару циклов экран
// приходит в соответствие.
//
// Лечим тремя механизмами сразу:
//   1. viewSeq / lastRenderedSeq — порядковый номер запроса. Ответ,
//      который пришёл позже, но описывает более раннее состояние, чем
//      уже отрисованное, просто выбрасывается.
//   2. actionGeneration — счётчик действий. Любой опрос, начавшийся ДО
//      действия, отбрасывается целиком: он физически не мог видеть
//      результат этого действия.
//   3. pendingMutations — пока действие в полёте, фоновые опросы вообще
//      не стартуют и все кнопки заблокированы (класс app-busy).
var viewSeq = 0;             // номер, присваиваемый каждому запросу состояния
var lastRenderedSeq = 0;     // номер запроса, чей ответ уже нарисован
var actionGeneration = 0;    // растёт на каждое действие пользователя
var pendingMutations = 0;    // сколько действий сейчас выполняется
var mutationStartedAt = 0;   // когда началось самое раннее из них

// Страховка: fetch() может зависнуть без ошибки (мобильная сеть уснула,
// VPN переключил страну). Без неё экран остался бы навсегда с
// заблокированными кнопками и без обновлений.
var MUTATION_WATCHDOG_MS = 45000;

function setBusy(isBusy) {
  document.body.classList.toggle('app-busy', !!isBusy);
}

function beginMutation() {
  if (pendingMutations === 0) mutationStartedAt = Date.now();
  pendingMutations++;
  actionGeneration++;
  setBusy(true);
}

function endMutation() {
  pendingMutations = Math.max(0, pendingMutations - 1);
  if (pendingMutations === 0) mutationStartedAt = 0;
  setBusy(pendingMutations > 0);
}

function releaseStuckMutations_() {
  if (pendingMutations > 0 && mutationStartedAt && Date.now() - mutationStartedAt > MUTATION_WATCHDOG_MS) {
    pendingMutations = 0;
    mutationStartedAt = 0;
    setBusy(false);
  }
}

// Несмотря на название (оставлено для минимальных правок во всех вызовах
// ниже), это ТОЖЕ обычный GET, а не настоящий POST. Apps Script на POST
// к /exec отвечает 302-редиректом на googleusercontent.com, и этот
// редирект либо не принимает POST, либо fetch() при переходе по нему
// превращает его в GET и теряет тело запроса — задокументированная
// особенность самого Apps Script. GET проходит по тому же редиректу без
// проблем, поэтому и запись, и чтение идут через query-параметры.
//
// Через apiPost идут ВСЕ изменяющие действия — поэтому счётчики
// «действие в полёте» удобно вести прямо здесь, а не дублировать в
// каждом обработчике кнопки.
function apiPost(action, username, payload) {
  if (!EXEC_URL || EXEC_URL.indexOf('ВСТАВЬТЕ') !== -1) {
    return Promise.reject(new Error('EXEC_URL не задан — вставьте ссылку на ваш деплой Apps Script в App.js.'));
  }
  var url = EXEC_URL + '?action=' + encodeURIComponent(action) + '&u=' + encodeURIComponent(username || '');
  Object.keys(payload || {}).forEach(function (k) {
    var v = payload[k];
    if (v && typeof v === 'object') v = JSON.stringify(v);
    url += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(v);
  });
  url += impersonationSuffix_();
  url += '&_ts=' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

  beginMutation();
  // Счётчик снимается ДО обработчика вызывающей стороны — чтобы
  // loadPlayerDashboard() внутри её .then() уже не считался
  // заблокированным и обновил экран сразу после действия.
  return fetchJsonWithRetry_(url).then(
    function (data) { endMutation(); applyServerState_(data); return data; },
    function (err) { endMutation(); throw err; }
  );
}

// v3.3 — ГЛАВНЫЙ ФИКС «ЗАГЛУШКИ НЕ РАБОТАЮТ, ЖДЁШЬ ДВА ЦИКЛА».
//
// Сервер теперь возвращает уже пересчитанное состояние прямо в ответе на
// действие (поле state). Рисуем его немедленно — второй запрос за
// состоянием не нужен вовсе, ждать нечего.
//
// Заодно двигаем счётчики очерёдности: свежесть этого состояния выше
// любого опроса, который стартовал раньше, поэтому все запоздавшие
// ответы после этого будут отброшены.
var lastStateAppliedAt = 0;
var STATE_FRESH_MS = 3000;   // столько считаем состояние из ответа свежим

function applyServerState_(res) {
  if (!res || res.ok !== true || !res.state) return false;

  lastRenderedSeq = ++viewSeq;
  lastStateAppliedAt = Date.now();

  if (myRole === 'admin') renderAdminMonitor(res.state);
  else renderPlayerDashboard(res.state);
  return true;
}

// ------------------------------------------------------------ ИНДИКАЦИЯ ЗАГРУЗКИ
//
// Оборачивает любое действие, инициированное кнопкой: сразу блокирует её
// и меняет текст, чтобы пользователь понимал, что нажатие принято.
//
// v3.3. Раньше здесь была искусственная задержка BUTTON_LOADING_MIN_MS =
// 10 секунд: кнопка держалась заблокированной МИНИМУМ 10 секунд, чем бы
// ни ответил сервер. Это была подпорка под старую схему «действие →
// {ok:true} → отдельный запрос за состоянием → ждём опроса»: без неё
// экран успевал показать старые данные раньше новых.
//
// Теперь сервер возвращает свежее состояние прямо в ответе на действие
// (см. attachFreshState_ в Code.gs), и экран обновляется в тот же момент,
// когда приходит ответ. Держать кнопку заблокированной после этого не за
// чем — а вот выглядело это ровно как «ничего не происходит, надо
// ждать». Блокировка снимается сразу по факту ответа.
var BUTTON_LOADING_MIN_MS = 0;

function withButtonLoading(btn, loadingText, fn) {
  if (!btn) return fn();
  var original = btn.textContent;
  btn.disabled = true;
  btn.classList.add('btn-loading');
  btn.textContent = loadingText || 'Обработка…';

  function restore() {
    btn.disabled = false;
    btn.classList.remove('btn-loading');
    btn.textContent = original;
  }

  var minDelay = new Promise(function (resolve) { setTimeout(resolve, BUTTON_LOADING_MIN_MS); });
  var result = fn();
  var settled = (result && typeof result.then === 'function')
    ? result.then(function () {}, function () {}) // ждём завершения независимо от успеха/ошибки
    : Promise.resolve();

  Promise.all([settled, minDelay]).then(restore);
  return result;
}

// ------------------------------------------------------------ ИНИЦИАЛИЗАЦИЯ

var tg = window.Telegram ? window.Telegram.WebApp : null;
if (tg) { tg.ready(); tg.expand(); }

var urlParams = new URLSearchParams(window.location.search);
var DEV_USERNAME = urlParams.get('u') || '';

// v4.0. Режим ведущего: ?as=ник открывает кабинет этого игрока.
// Обычному игроку параметр бесполезен — сервер его игнорирует, если
// спрашивающий не ведущий, так что подобранная ссылка ничего не даёт.
// Нужен в двух ситуациях: подсмотреть, что происходит у игрока, который
// просит помощи, и отыграть партию на нескольких заведениях в одиночку
// при обкатке.
var IMPERSONATE_AS = urlParams.get('as') || '';

function impersonationSuffix_() {
  return IMPERSONATE_AS ? '&as=' + encodeURIComponent(IMPERSONATE_AS) : '';
}

var myUsername = (tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.username)
  ? tg.initDataUnsafe.user.username
  : DEV_USERNAME;

var myRole = null;
var pollTimer = null;

function showScreen(id) {
  ['loading', 'error-screen', 'player-app', 'admin-app'].forEach(function (s) {
    document.getElementById(s).classList.toggle('hidden', s !== id);
  });
}

function showError(text) {
  document.getElementById('error-text').textContent = text;
  showScreen('error-screen');
}

function boot() {
  if (!myUsername) {
    showError('Не удалось определить ваш Telegram-ник. Убедитесь, что в настройках Telegram задан @username.');
    return;
  }
  apiGet('identify', { u: myUsername })
    .then(function (id) {
      if (!id.ok) {
        var messages = {
          not_in_roster: 'Ваш ник (@' + myUsername + ') не найден в списке игроков. Обратитесь к ведущему.',
          no_username: 'Не удалось определить ваш Telegram-ник.'
        };
        showError(messages[id.error] || 'Ошибка входа.');
        return;
      }
      myRole = id.role;
      if (myRole === 'admin') { showScreen('admin-app'); loadAdminMonitor(); }
      else { showScreen('player-app'); loadPlayerDashboard(); }
      pollTimer = setInterval(myRole === 'admin' ? loadAdminMonitor : loadPlayerDashboard, 8000);
    })
    .catch(function (err) { showError('Ошибка соединения: ' + err.message); });
}

// ---------------------------------------------------------------- ФОРМАТ

function fmtMoney(m) {
  if (!m) return '—';
  return m.thb.toLocaleString('ru-RU') + ' ฿';
}
function fmtUsd(m) { return m ? '$' + m.usd.toLocaleString('en-US') : ''; }
function fmtSigned(m) {
  if (!m) return '—';
  var sign = m.thb < 0 ? '−' : '';
  return sign + Math.abs(m.thb).toLocaleString('ru-RU') + ' ฿';
}

// ------------------------------------------------------------ ТАЙМЕР МЕСЯЦА

var countdownInterval = null;
var countdownDeadlineMs = null;
var countdownFiredRefresh = false;

function startCountdown(deadlineIso, elementIds) {
  stopCountdown();
  if (!deadlineIso) {
    elementIds.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    });
    return;
  }
  countdownDeadlineMs = new Date(deadlineIso).getTime();
  countdownFiredRefresh = false;
  tickCountdown(elementIds);
  countdownInterval = setInterval(function () { tickCountdown(elementIds); }, 1000);
}

function stopCountdown() {
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
}

function tickCountdown(elementIds) {
  var remainingSec = Math.max(0, Math.round((countdownDeadlineMs - Date.now()) / 1000));
  var mm = String(Math.floor(remainingSec / 60)).padStart(2, '0');
  var ss = String(remainingSec % 60).padStart(2, '0');
  var text = mm + ':' + ss;
  var urgent = remainingSec <= 30;

  elementIds.forEach(function (id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.classList.remove('hidden');
    el.classList.toggle('timer-urgent', urgent);
  });

  // Как только время вышло — сразу подтягиваем свежее состояние, не дожидаясь
  // обычного 8-секундного опроса. Сам расчёт месяца сервер сделает при этом
  // же обращении (см. getCurrentRound_ в Code.gs), так что результат уже
  // будет готов к отображению.
  if (remainingSec <= 0 && !countdownFiredRefresh) {
    countdownFiredRefresh = true;
    stopCountdown();
    if (myRole === 'admin') loadAdminMonitor(true); else loadPlayerDashboard(true);
  }
}

// ------------------------------------------------------------ ИГРОК: UI

function loadPlayerDashboard(force) {
  releaseStuckMutations_();
  // Пока действие игрока в полёте — не дёргаем сервер за состоянием
  // вовсе: ответ всё равно описывал бы момент ДО действия.
  if (pendingMutations > 0) return Promise.resolve();

  // v3.3. Состояние только что пришло вместе с ответом на действие и уже
  // нарисовано — повторный запрос за тем же самым не нужен. Обработчики
  // кнопок по-прежнему вызывают loadPlayerDashboard() как страховку на
  // случай, если сервер состояние не приложил; здесь эта страховка и
  // отсекается, чтобы не гонять лишний круг по сети.
  if (!force && Date.now() - lastStateAppliedAt < STATE_FRESH_MS) return Promise.resolve();

  var seq = ++viewSeq;
  var gen = actionGeneration;

  return apiGet('dashboard', { u: myUsername })
    .then(function (d) {
      if (seq <= lastRenderedSeq) return;       // прилетел ответ старее уже нарисованного
      if (gen !== actionGeneration) return;     // пока летел, игрок успел что-то сделать
      lastRenderedSeq = seq;
      renderPlayerDashboard(d);
    })
    .catch(function (err) { reportLoadError_(err); });
}

// Единичный сбой фонового опроса не должен сносить уже работающий экран
// в красную заглушку — до первой удачной отрисовки показываем ошибку,
// дальше просто тихо ждём следующего цикла (он через 8 секунд).
function reportLoadError_(err) {
  if (!lastRenderedSeq) { showError('Ошибка соединения: ' + err.message); return; }
  if (window.console && console.warn) console.warn('Фоновый опрос не удался, пробуем на следующем цикле:', err.message);
}

var lastDashboard = null;

var CAREER_LABELS = {
  civil_service: 'Вы на госслужбе',
  freelance: 'Вы в свободном плавании',
  custom_employed: 'Ваша профессия'
};

function renderPlayerDashboard(d) {
  if (!d.ok) { showError('Ошибка загрузки данных.'); return; }
  lastDashboard = d;

  var onboarding = document.getElementById('onboarding-card');
  var main = document.getElementById('player-main');
  var bankruptCard = document.getElementById('bankrupt-card');
  var offbusinessCard = document.getElementById('offbusiness-card');
  var leftCard = document.getElementById('left-card');

  document.getElementById('p-restaurant').textContent = d.player.restaurant;

  // Итоги последнего сыгранного месяца рендерятся независимо от текущего
  // статуса — банкроту и наёмному тоже нужно видеть, что произошло, а не
  // упираться в голую заглушку (см. index.html — карточка вынесена за
  // пределы player-main специально ради этого).
  renderLastResult(d.lastResult);

  if (d.lifecycle === 'left') {
    [onboarding, main, bankruptCard, offbusinessCard].forEach(function (el) { el.classList.add('hidden'); });
    leftCard.classList.remove('hidden');
    document.getElementById('my-employees-card').classList.add('hidden');
    document.getElementById('p-round').textContent = '';
    document.getElementById('p-cash-thb').textContent = '';
    document.getElementById('p-cash-usd').textContent = '';
    stopCountdown();
    return;
  }
  if (d.lifecycle === 'bankrupt') {
    [onboarding, main, offbusinessCard, leftCard].forEach(function (el) { el.classList.add('hidden'); });
    bankruptCard.classList.remove('hidden');
    document.getElementById('my-employees-card').classList.add('hidden');
    document.getElementById('p-cash-thb').textContent = fmtMoney(d.player.cash);
    document.getElementById('p-cash-usd').textContent = '';
    document.getElementById('bankrupt-details').textContent =
      'Госслужба — фиксированная зарплата ' + fmtMoney(d.careerOptions.civilServiceSalary) +
      '/мес автоматически. Свободное плавание — просите переводы от других игроков. Своя профессия — ' +
      'договариваетесь о зарплате с конкретным игроком. В любом случае для нового дела нужно накопить ' +
      fmtMoney(d.careerOptions.reopenThreshold) + '.';
    stopCountdown();
    return;
  }
  if (['civil_service', 'freelance', 'custom_employed'].indexOf(d.lifecycle) !== -1) {
    [onboarding, main, bankruptCard, leftCard].forEach(function (el) { el.classList.add('hidden'); });
    offbusinessCard.classList.remove('hidden');
    document.getElementById('my-employees-card').classList.add('hidden');
    document.getElementById('p-cash-thb').textContent = '';
    document.getElementById('p-cash-usd').textContent = '';
    document.getElementById('offbusiness-title').textContent = CAREER_LABELS[d.lifecycle];
    safeRenderInto('offbusiness-content', renderOffBusinessContent(d));
    document.getElementById('reopen-btn').classList.toggle('hidden', !d.employment.canReopen);
    stopCountdown();
    return;
  }
  [bankruptCard, offbusinessCard, leftCard].forEach(function (el) { el.classList.add('hidden'); });

  document.getElementById('p-round').textContent = 'Месяц ' + d.game.roundNumber + ' из ' + d.game.totalRounds +
    (d.game.gameFinished ? ' · игра завершена' : (d.game.roundStatus === 'open' ? ' · приём решений открыт' : ' · идёт обсуждение'));

  if (d.needsOnboarding) {
    onboarding.classList.remove('hidden');
    main.classList.add('hidden');
    return;
  }
  onboarding.classList.add('hidden');
  main.classList.remove('hidden');

  document.getElementById('p-cash-thb').textContent = fmtMoney(d.player.cash);
  document.getElementById('p-cash-usd').textContent = fmtUsd(d.player.cash);
  document.getElementById('p-brand').textContent = d.player.brand;
  document.getElementById('p-rep').textContent = d.player.reputation;
  document.getElementById('p-quality').textContent = d.player.quality;
  document.getElementById('p-capacity').textContent = d.player.capacity.toLocaleString('ru-RU');

  // Персонал
  document.getElementById('staff-info').textContent =
    'Одна смена: ' + d.staff.shiftStepCapacity.toLocaleString('ru-RU') + ' клиентов ёмкости, ' +
    fmtMoney(d.staff.shiftStepCost) + '/мес';

  // Баннер банка
  var banner = document.getElementById('bank-banner');
  if (d.bankNotifications && d.bankNotifications.length) {
    banner.textContent = '🏦 ' + d.bankNotifications[d.bankNotifications.length - 1].message + ' (нажмите, чтобы скрыть)';
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }

  renderMarketingBadges(d.marketing);
  renderBank(d.loan);
  renderDecisionForm(d);
  renderTransferOptions(d.otherPlayers);
  renderMyEmployees(d.myEmployees);
  startCountdown(d.game.roundStatus === 'open' ? d.game.deadline : null, ['p-timer']);
}

// Кнопки переключения на ДРУГОЙ путь вне бизнеса — на каждом экране не
// показываем кнопку текущего же пути (незачем "переключаться" сам на себя).
function careerSwitchButtonsHtml(excludePath) {
  var options = [
    ['civil_service', 'Госслужба'],
    ['freelance', 'Свободное плавание'],
    ['custom', 'Своя профессия']
  ].filter(function (o) { return o[0] !== excludePath; });
  var html = '<div class="career-actions" style="margin-top:14px;">';
  options.forEach(function (o) {
    if (o[0] === 'custom') {
      html += '<button class="btn-secondary" onclick="toggleCustomProfessionForm(\'switch\')">' + o[1] + '</button>';
    } else {
      html += '<button class="btn-secondary" onclick="chooseCareerPath(\'' + o[0] + '\', this)">' + o[1] + '</button>';
    }
  });
  html += '</div>' +
    '<div id="custom-profession-form-switch" class="hidden custom-profession-form">' +
    '<input type="text" id="custom-profession-name-switch" placeholder="Название профессии">' +
    '<button class="btn-secondary" onclick="submitCustomProfession(\'switch\', this)">Продолжить</button></div>';
  return html;
}

// Периодический опрос (каждые ~8 сек) раньше перерисовывал этот блок
// БЕЗУСЛОВНО через innerHTML — а innerHTML не "обновляет" поля ввода,
// а физически уничтожает их и создаёт заново пустыми. Если человек в
// этот момент печатал (например, желаемую зарплату), ввод стирался.
// Теперь: если фокус сейчас внутри этого блока — просто пропускаем
// перерисовку на этом цикле, ничего не трогаем.
function safeRenderInto(containerId, html) {
  var container = document.getElementById(containerId);
  if (!container) return;
  var active = document.activeElement;
  if (active && container.contains(active)) return;
  container.innerHTML = html;
}

function renderOffBusinessContent(d) {
  var html = '<table class="pl-table">' +
    '<tr><td>Накоплено</td><td>' + fmtMoney(d.employment.savings) + '</td></tr>' +
    '<tr><td>Нужно для открытия дела</td><td>' + fmtMoney(d.employment.threshold) + '</td></tr>';

  if (d.lifecycle === 'civil_service') {
    html += '<tr><td>Зарплата</td><td>' + fmtMoney(d.employment.salary) + '/мес</td></tr>';

    // v3.3: видно, за какие месяцы зарплата уже начислена. Начисление
    // происходит в момент ЗАКРЫТИЯ месяца — за месяц, который вы на
    // службе отработали, а не авансом в начале.
    if (d.employment.serviceSinceRound) {
      html += '<tr><td>На службе с месяца</td><td>' + d.employment.serviceSinceRound + '</td></tr>' +
        '<tr><td>Зарплата начислена по месяц</td><td>' +
        (d.employment.salaryPaidThroughRound || '— ещё не начислялась') + '</td></tr>';
    }
    html += '</table>';

    if (d.employment.salaryPending) {
      html += '<p class="muted">Зарплата за текущий месяц придёт, когда ведущий закроет месяц.</p>';
    }
    html += '<p class="muted">Начисляется автоматически за каждый отработанный месяц. Не забудьте зачитать ' +
      'остальным короткую рекламу госбанка — по легенде это ваша обязанность (в игре не проверяется).</p>';
    html += careerSwitchButtonsHtml('civil_service');
    return html;
  }

  if (d.lifecycle === 'freelance') {
    html += '</table><p class="muted">Здесь нечего нажимать — убедите других игроков перевести вам стартовый ' +
      'капитал (раздел «Перевести деньги» есть у каждого активного игрока). Как только накопится нужная сумма — ' +
      'откроется кнопка «Открыть новое дело».</p>';
    if (d.otherActivePlayers && d.otherActivePlayers.length) {
      html += '<p class="muted">Сейчас активны: ' + d.otherActivePlayers.map(function (p) { return p.restaurant; }).join(', ') + '.</p>';
    }
    html += careerSwitchButtonsHtml('freelance');
    return html;
  }

  // custom_employed
  html += '<tr><td>Профессия</td><td>' + (d.employment.professionName || '—') + '</td></tr>';
  if (d.employment.employerUsername) {
    html += '<tr><td>Наниматель</td><td>' + d.employment.employerUsername + '</td></tr>' +
      '<tr><td>Предложенная зарплата</td><td>' + fmtMoney(d.employment.proposedSalary) + '</td></tr>' +
      '<tr><td>Статус</td><td>' + (d.employment.approved
        ? (d.employment.paidThisRound ? 'Одобрено, оплачено в этом месяце ✓' : 'Одобрено, ждём оплаты в этом месяце')
        : 'Ждём одобрения от нанимателя') + '</td></tr>';
  }
  html += '</table>';

  html += '<div class="career-actions" style="margin-top:14px;">' +
    '<label>Кому предложить себя<select id="employer-select"></select></label>' +
    '<div class="repay-block"><input type="number" id="employer-salary" placeholder="Желаемая зарплата, ฿" step="1000">' +
    '<button class="btn-secondary" onclick="proposeEmployment(this)">Предложить</button></div></div>';

  setTimeout(function () {
    var select = document.getElementById('employer-select');
    if (!select) return;
    select.innerHTML = '';
    (d.otherActivePlayers || []).forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p.username; opt.textContent = p.restaurant;
      select.appendChild(opt);
    });
  }, 0);

  // Пока ждёт согласования (или уже работает, но недоволен) — тоже можно
  // передумать и уйти на другой путь, не дожидаясь ответа нанимателя.
  html += '<p class="muted" style="margin-top:14px;">Не хотите больше ждать согласования или работать здесь?</p>';
  html += careerSwitchButtonsHtml('custom');

  return html;
}

// ------------------------------------------------------- МОИ СОТРУДНИКИ (v3.2)
//
// Самый заметный симптом бага с устаревшими ответами был именно здесь:
// нажал «Одобрить» — через 8 секунд снова кнопки выбора, и только через
// пару циклов экран приходит в соответствие. Кроме общей защиты от
// устаревших ответов (см. блок про viewSeq), карточка конкретного
// сотрудника теперь блокируется МГНОВЕННО по нажатию и показывает, какой
// именно выбор сделан, пока сервер не подтвердит его в данных.
var pendingEmployeeActions = {};   // username -> { type, label }
var PENDING_ACTION_TTL_MS = 60000; // страховка: если ответ потерялся, не блокируем навсегда
var lastEmployeesData = [];
var lastEmployeesSignature = null;

var PENDING_ACTION_LABELS = {
  approve: 'Одобряем…',
  reject: 'Отклоняем…',
  pay: 'Выплачиваем…'
};

function setPendingEmployeeAction(username, type) {
  pendingEmployeeActions[username] = {
    type: type, label: PENDING_ACTION_LABELS[type] || 'Обрабатываем…', startedAt: Date.now()
  };
  renderMyEmployees(lastEmployeesData); // мгновенно, не дожидаясь сервера
}

function clearPendingEmployeeAction(username) {
  delete pendingEmployeeActions[username];
  renderMyEmployees(lastEmployeesData);
}

// Действие считается завершённым, когда его результат ВИДЕН в данных с
// сервера. До этого момента кнопки не возвращаем, чем бы ни ответил
// очередной опрос.
function pendingActionResolved_(pending, employee) {
  if (!pending) return true;
  if (Date.now() - pending.startedAt > PENDING_ACTION_TTL_MS) return true;
  if (pending.type === 'approve') return !!(employee && employee.approved);
  if (pending.type === 'reject') return !employee;   // отклонённый сотрудник исчезает из списка
  if (pending.type === 'pay') return !!(employee && employee.paidThisRound);
  return true;
}

function renderMyEmployees(employees) {
  lastEmployeesData = employees || [];

  var card = document.getElementById('my-employees-card');
  var list = document.getElementById('my-employees-list');

  var byUsername = {};
  lastEmployeesData.forEach(function (e) { byUsername[e.username] = e; });

  // Снимаем блокировку с тех, чьё действие уже отражено в данных.
  Object.keys(pendingEmployeeActions).forEach(function (u) {
    if (pendingActionResolved_(pendingEmployeeActions[u], byUsername[u])) delete pendingEmployeeActions[u];
  });

  if (!lastEmployeesData.length) {
    card.classList.add('hidden');
    lastEmployeesSignature = null;
    return;
  }
  card.classList.remove('hidden');

  var html = lastEmployeesData.map(function (e) {
    var pending = pendingEmployeeActions[e.username];
    var actions;

    if (pending) {
      // Ввод заблокирован, показан фактически сделанный выбор.
      actions = '<span class="employee-pending">' + pending.label + '</span>';
    } else if (!e.approved) {
      actions = '<button class="btn-secondary" onclick="respondToEmployment(\'' + e.username + '\', true, this)">Одобрить</button>' +
        '<button class="btn-danger" onclick="respondToEmployment(\'' + e.username + '\', false, this)">Отклонить</button>';
    } else if (e.paidThisRound) {
      actions = '<span class="employee-paid">Оплачено в этом месяце ✓</span>';
    } else {
      actions = '<button class="btn-secondary" onclick="paySalaryTo(\'' + e.username + '\', this)">Выплатить ' + fmtMoney(e.salary) + '</button>';
    }

    var statusLine = e.approved
      ? '<div class="employee-status ok">Одобрен' + (e.paidThisRound ? ' · зарплата за месяц выплачена' : ' · ждёт выплаты за этот месяц') + '</div>'
      : '<div class="employee-status pending">Ждёт вашего решения</div>';

    return '<div class="employee-item' + (pending ? ' employee-item-busy' : '') + '">' +
      '<div class="employee-head"><span class="employee-name">' + e.displayName + '</span></div>' +
      '<div class="employee-meta">' + e.profession + ' · зарплата ' + fmtMoney(e.salary) + '/мес</div>' +
      statusLine +
      '<div class="employee-actions">' + actions + '</div>' +
      '</div>';
  }).join('');

  // Перерисовываем только когда содержимое реально изменилось — иначе
  // каждые 8 секунд блок моргал и кнопка под пальцем пересоздавалась.
  if (html === lastEmployeesSignature) return;
  lastEmployeesSignature = html;
  list.innerHTML = html;
}

function renderTransferOptions(otherPlayers) {
  var select = document.getElementById('transfer-to');
  var current = select.value;
  select.innerHTML = '';
  (otherPlayers || []).forEach(function (p) {
    var opt = document.createElement('option');
    opt.value = p.username;
    opt.textContent = p.restaurant;
    select.appendChild(opt);
  });
  if (current && Array.from(select.options).some(function (o) { return o.value === current; })) {
    select.value = current;
  }
}

function renderMarketingBadges(mk) {
  var seoBadge = document.getElementById('ch-seo-badge');
  if (mk.seoUnlocked) seoBadge.textContent = 'разблокировано, уровень ' + mk.seoLevel;
  else seoBadge.textContent = 'подряд ' + mk.seoStreak + ' из ' + mk.seoRampMonths + ' мес.';

  document.getElementById('ch-maps-badge').textContent = 'накоплено: ' + mk.mapsLevel;
  document.getElementById('ch-social-badge').textContent = 'накоплено: ' + mk.socialAdstock;
  document.getElementById('ch-outdoor-badge').textContent = mk.outdoorActive
    ? 'активна до месяца ' + mk.outdoorActiveUntil
    : 'не размещена';
  document.getElementById('ch-affiliate-badge').textContent = mk.affiliateActive ? 'активна' : 'не активна';
}

function renderBank(loan) {
  document.getElementById('bank-balance').textContent = fmtMoney(loan.balance);
  document.getElementById('bank-rate').textContent = Math.round(loan.rateAnnual * 100) + '% годовых';
  document.getElementById('bank-payment').textContent = loan.balance.thb > 0 ? fmtMoney(loan.estimatedNextPayment) : '—';
  document.getElementById('bank-term').textContent = loan.termLeft || '—';
  document.getElementById('bank-available').textContent = fmtMoney(loan.available);

  document.getElementById('loan-request-block').classList.toggle('hidden', loan.tier < 1 || loan.available.thb <= 0);
}

function renderLastResult(r) {
  var card = document.getElementById('last-result-card');
  if (!r) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');

  // Называем месяц явно: у игрока вне бизнеса это последний месяц, когда
  // он реально вёл дело, а не «прошлый».
  var title = document.getElementById('last-result-title');
  if (title) title.textContent = 'Итоги месяца ' + r.roundNumber;

  var total = Math.max(1, r.served + r.lost);
  document.getElementById('r-served-bar').style.width = (100 * r.served / total) + '%';
  document.getElementById('r-lost-bar').style.width = (100 * r.lost / total) + '%';
  document.getElementById('r-served').textContent = r.served.toLocaleString('ru-RU');
  document.getElementById('r-lost').textContent = r.lost.toLocaleString('ru-RU');

  document.getElementById('r-revenue').textContent = fmtMoney(r.revenue);
  document.getElementById('r-cogs').textContent = fmtSigned({ thb: -r.cogs.thb });
  document.getElementById('r-gross').textContent = fmtSigned(r.grossProfit);
  document.getElementById('r-rent').textContent = fmtSigned({ thb: -r.opex.rent.thb });
  document.getElementById('r-payroll').textContent = fmtSigned({ thb: -r.opex.payroll.thb });
  document.getElementById('r-shiftcost').textContent = fmtSigned({ thb: -r.opex.shiftCost.thb });
  document.getElementById('r-qupkeep').textContent = fmtSigned({ thb: -r.opex.qualityUpkeep.thb });
  document.getElementById('r-qinvest').textContent = fmtSigned({ thb: -r.opex.qualityInvest.thb });
  document.getElementById('r-marketing').textContent = fmtSigned({ thb: -r.opex.marketing.thb });
  document.getElementById('r-ebit').textContent = fmtSigned(r.ebit);
  document.getElementById('r-interest').textContent = fmtSigned({ thb: -r.interest.thb });
  document.getElementById('r-profit').textContent = fmtSigned(r.profit);
  document.getElementById('r-principal').textContent = fmtSigned({ thb: -r.principalPaid.thb });
  document.getElementById('r-cf').textContent = fmtSigned(r.cashFlow);
  document.getElementById('r-share').textContent = r.marketShare + '%';

  document.getElementById('r-mk-seo').textContent = fmtMoney(r.marketingByChannel.seo);
  document.getElementById('r-mk-promo').textContent = fmtMoney(r.marketingByChannel.promo);
  document.getElementById('r-mk-maps').textContent = fmtMoney(r.marketingByChannel.maps);
  document.getElementById('r-mk-social').textContent = fmtMoney(r.marketingByChannel.social);
  document.getElementById('r-mk-outdoor').textContent = fmtMoney(r.marketingByChannel.outdoor);
  document.getElementById('r-mk-affiliate').textContent = fmtMoney(r.marketingByChannel.affiliate);
}

var decisionFormInitializedForRound = null;

function renderDecisionForm(d) {
  var form = document.getElementById('decision-form');
  var waiting = document.getElementById('decision-waiting');
  var closed = document.getElementById('decision-closed');
  form.classList.add('hidden'); waiting.classList.add('hidden'); closed.classList.add('hidden');

  if (d.game.gameFinished) {
    closed.classList.remove('hidden');
    closed.querySelector('p').textContent = 'Игра завершена (' + d.game.totalRounds + ' мес.). Дождитесь новой игры от ведущего.';
  } else if (d.game.roundStatus !== 'open') {
    closed.classList.remove('hidden');
    closed.querySelector('p').textContent = 'Приём решений сейчас закрыт. Обсуждайте стратегию — форма откроется, когда ведущий начнёт месяц.';
  } else if (d.myDecisionSubmitted) {
    waiting.classList.remove('hidden');
  } else {
    form.classList.remove('hidden');
    document.getElementById('decision-title').textContent = 'Решение на месяц ' + d.game.roundNumber;
    // Значение по умолчанию для цены — ТОЛЬКО при первом появлении формы
    // для этого конкретного месяца, не на каждый опрос (раньше проверка
    // "если поле пустое" срабатывала на каждый цикл — обычно безобидно,
    // но при определённых мобильных сценариях число могло промежуточно
    // выглядеть пустым во время ввода, и опрос успевал его перетереть).
    if (decisionFormInitializedForRound !== d.game.roundNumber) {
      decisionFormInitializedForRound = d.game.roundNumber;
      if (!document.getElementById('f-price').value) document.getElementById('f-price').value = 300;
    }
  }
}

document.getElementById('onboarding-form').addEventListener('submit', function (e) {
  e.preventDefault();
  var btn = e.target.querySelector('button[type=submit]');
  var name = document.getElementById('ob-name').value;
  var restaurant = document.getElementById('ob-restaurant').value;
  withButtonLoading(btn, 'Сохраняем…', function () {
    return apiPost('setProfile', myUsername, { displayName: name, restaurantName: restaurant })
      .then(function (res) {
        if (res.ok) loadPlayerDashboard();
        else alert('Заполните оба поля.');
      })
      .catch(function (err) { alert('Ошибка: ' + err.message); });
  });
});

document.getElementById('decision-form').addEventListener('submit', function (e) {
  e.preventDefault();
  var btn = e.target.querySelector('button[type=submit]');
  var decision = {
    price: document.getElementById('f-price').value,
    seoSpend: document.getElementById('f-seo').value,
    promoSpend: document.getElementById('f-promo').value,
    mapsSpend: document.getElementById('f-maps').value,
    socialSpend: document.getElementById('f-social').value,
    outdoorSpend: document.getElementById('f-outdoor').value,
    affiliateSpend: document.getElementById('f-affiliate').value,
    shiftsDelta: document.getElementById('f-shifts').value,
    qualityInvest: document.getElementById('f-quality').value
  };

  // Проверяем на клиенте ДО отправки — чтобы предупреждение появлялось
  // мгновенно, а не после круга до сервера и обратно. Сервер всё равно
  // проверяет то же самое сам — это только для скорости отклика.
  if (lastDashboard && lastDashboard.game) {
    var price = Number(decision.price) || 0;
    var floor = lastDashboard.game.priceFloor.thb;
    var ceiling = lastDashboard.game.priceCeiling.thb;
    if (price < floor) {
      alert('Цена не может быть ниже ' + floor.toLocaleString('ru-RU') + ' ฿. Поправьте и отправьте снова.');
      return;
    }
    if (price > ceiling) {
      alert('Цена не может быть выше ' + ceiling.toLocaleString('ru-RU') + ' ฿. Поправьте и отправьте снова.');
      return;
    }
    var totalSpend = ['seoSpend', 'promoSpend', 'mapsSpend', 'socialSpend', 'outdoorSpend', 'affiliateSpend', 'qualityInvest']
      .reduce(function (sum, key) { return sum + (Number(decision[key]) || 0); }, 0);
    var cash = lastDashboard.player.cash.thb;
    if (totalSpend > cash) {
      alert('Суммарные траты (' + totalSpend.toLocaleString('ru-RU') + ' ฿) больше, чем есть в кассе (' +
        cash.toLocaleString('ru-RU') + ' ฿). Уменьшите расходы и отправьте снова.');
      return;
    }
  }

  withButtonLoading(btn, 'Отправляем…', function () {
    return apiPost('submitDecision', myUsername, decision)
      .then(function (res) {
        if (res.ok) { loadPlayerDashboard(); return; }
        var messages = {
          price_too_low: 'Цена не может быть ниже ' + (res.min ? res.min.thb.toLocaleString('ru-RU') + ' ฿' : 'минимума') + '.',
          price_too_high: 'Цена не может быть выше ' + (res.max ? res.max.thb.toLocaleString('ru-RU') + ' ฿' : 'максимума') + '.',
          insufficient_cash: 'Суммарные траты (' + (res.totalSpend ? res.totalSpend.thb.toLocaleString('ru-RU') : '?') +
            ' ฿) больше, чем есть в кассе (' + (res.available ? res.available.thb.toLocaleString('ru-RU') : '?') + ' ฿).'
        };
        alert(messages[res.error] || ('Не удалось отправить решение: ' + res.error));
      })
      .catch(function (err) { alert('Ошибка: ' + err.message); });
  });
});

function requestLoan(btn) {
  var amount = document.getElementById('loan-amount').value;
  if (!amount || Number(amount) <= 0) { alert('Укажите сумму кредита.'); return; }
  withButtonLoading(btn, 'Оформляем…', function () {
    return apiPost('requestLoan', myUsername, { amount: amount })
      .then(function (res) {
        if (res.ok) {
          alert('Получено: ' + fmtMoney(res.received));
          document.getElementById('loan-amount').value = '';
          loadPlayerDashboard();
        } else {
          var messages = { no_tier: 'Кредит пока недоступен — банк ещё не открыл лимит.', invalid_amount: 'Некорректная сумма.', limit_reached: 'Лимит уже полностью выбран.' };
          alert(messages[res.error] || ('Кредит недоступен: ' + res.error));
        }
      })
      .catch(function (err) { alert('Ошибка: ' + err.message); });
  });
}

function repayLoan(btn) {
  var amount = document.getElementById('repay-amount').value;
  if (!amount || Number(amount) <= 0) { alert('Укажите сумму погашения.'); return; }
  withButtonLoading(btn, 'Погашаем…', function () {
    return apiPost('repayLoan', myUsername, { amount: amount })
      .then(function (res) {
        if (res.ok) {
          alert('Погашено: ' + fmtMoney(res.paid) + '. Остаток долга: ' + fmtMoney(res.remaining));
          document.getElementById('repay-amount').value = '';
          loadPlayerDashboard();
        } else {
          alert('Не удалось погасить: ' + res.error);
        }
      })
      .catch(function (err) { alert('Ошибка: ' + err.message); });
  });
}

function transferMoney(btn) {
  var toUsername = document.getElementById('transfer-to').value;
  var amount = document.getElementById('transfer-amount').value;
  if (!toUsername) { alert('Выберите получателя.'); return; }
  if (!amount || Number(amount) <= 0) { alert('Укажите сумму перевода.'); return; }

  if (lastDashboard && lastDashboard.player && Number(amount) > lastDashboard.player.cash.thb) {
    alert('В кассе только ' + lastDashboard.player.cash.thb.toLocaleString('ru-RU') +
      ' ฿ — столько перевести нельзя. Уменьшите сумму и попробуйте снова.');
    return;
  }

  withButtonLoading(btn, 'Переводим…', function () {
    return apiPost('transferMoney', myUsername, { toUsername: toUsername, amount: amount })
      .then(function (res) {
        if (res.ok) {
          alert('Переведено ' + fmtMoney(res.sent) + ' → ' + res.toRestaurant);
          document.getElementById('transfer-amount').value = '';
          loadPlayerDashboard();
        } else {
          var messages = {
            invalid_amount: 'Укажите сумму больше нуля.',
            insufficient_cash: 'В кассе только ' + (res.available ? res.available.thb.toLocaleString('ru-RU') : '?') +
              ' ฿ — столько перевести нельзя.',
            recipient_not_found: 'Получатель не найден.', recipient_gone: 'Этот игрок уже вышел из игры.',
            self_transfer: 'Нельзя перевести самому себе.'
          };
          alert(messages[res.error] || ('Не удалось перевести: ' + res.error));
        }
      })
      .catch(function (err) { alert('Ошибка: ' + err.message); });
  });
}

function chooseCareerPath(path, btn) {
  withButtonLoading(btn, 'Обрабатываем…', function () {
    return apiPost('chooseCareerPath', myUsername, { path: path })
      .then(function (res) {
        if (res.ok) loadPlayerDashboard();
        else {
          var messages = {
            invalid_state: 'Сейчас нельзя сменить деятельность — обновите страницу и попробуйте снова.',
            busy: 'Ведущий прямо сейчас считает месяц. Нажмите ещё раз через несколько секунд.'
          };
          alert(messages[res.error] || ('Не удалось выполнить: ' + res.error));
        }
      })
      .catch(function (err) { alert('Ошибка: ' + err.message); });
  });
}

function toggleCustomProfessionForm(context) {
  var form = document.getElementById('custom-profession-form-' + context);
  form.classList.toggle('hidden');
}

function submitCustomProfession(context, btn) {
  var input = document.getElementById('custom-profession-name-' + context);
  var name = input.value.trim();
  if (!name) { alert('Введите название профессии.'); return; }
  withButtonLoading(btn, 'Обрабатываем…', function () {
    return apiPost('chooseCareerPath', myUsername, { path: 'custom', professionName: name })
      .then(function (res) {
        if (res.ok) { input.value = ''; loadPlayerDashboard(); }
        else alert('Не удалось выполнить: ' + res.error);
      })
      .catch(function (err) { alert('Ошибка: ' + err.message); });
  });
}

function proposeEmployment(btn) {
  var employerUsername = document.getElementById('employer-select').value;
  var salary = document.getElementById('employer-salary').value;
  if (!employerUsername) { alert('Выберите, кому предложить себя.'); return; }
  if (!salary || Number(salary) <= 0) { alert('Укажите желаемую зарплату.'); return; }
  withButtonLoading(btn, 'Отправляем…', function () {
    return apiPost('proposeEmployment', myUsername, { employerUsername: employerUsername, salary: salary })
      .then(function (res) {
        if (res.ok) { alert('Предложение отправлено — ждите одобрения.'); loadPlayerDashboard(); }
        else {
          var messages = {
            employer_not_active: 'Этот игрок сейчас не ведёт бизнес — выберите другого.',
            employer_not_found: 'Игрок не найден.', self_employer: 'Нельзя предложить себя самому себе.'
          };
          alert(messages[res.error] || ('Не удалось отправить: ' + res.error));
        }
      })
      .catch(function (err) { alert('Ошибка: ' + err.message); });
  });
}

function respondToEmployment(employeeUsername, approve, btn) {
  withButtonLoading(btn, approve ? 'Одобряем…' : 'Отклоняем…', function () {
    // Блокируем карточку сразу, до ответа сервера: кнопки исчезают,
    // на их месте — сделанный выбор. Разблокируется только когда сервер
    // подтвердит его в данных (см. pendingActionResolved_).
    setPendingEmployeeAction(employeeUsername, approve ? 'approve' : 'reject');

    return apiPost('respondToEmployment', myUsername, { employeeUsername: employeeUsername, approve: approve })
      .then(function (res) {
        if (res.ok) { loadPlayerDashboard(); return; }
        clearPendingEmployeeAction(employeeUsername);
        var messages = { not_your_employee: 'Этот игрок больше не числится вашим кандидатом — экран сейчас обновится.' };
        alert(messages[res.error] || ('Не удалось выполнить: ' + res.error));
        loadPlayerDashboard();
      })
      .catch(function (err) {
        clearPendingEmployeeAction(employeeUsername);
        alert('Ошибка: ' + err.message);
      });
  });
}

function paySalaryTo(employeeUsername, btn) {
  withButtonLoading(btn, 'Платим…', function () {
    setPendingEmployeeAction(employeeUsername, 'pay');

    return apiPost('paySalary', myUsername, { employeeUsername: employeeUsername })
      .then(function (res) {
        if (res.ok) { loadPlayerDashboard(); return; }
        clearPendingEmployeeAction(employeeUsername);
        var messages = {
          already_paid: 'В этом месяце уже оплачено.',
          insufficient_cash: 'В кассе недостаточно денег на эту зарплату.'
        };
        alert(messages[res.error] || ('Не удалось выплатить: ' + res.error));
        loadPlayerDashboard();
      })
      .catch(function (err) {
        clearPendingEmployeeAction(employeeUsername);
        alert('Ошибка: ' + err.message);
      });
  });
}

// Открывает табло во ВНЕШНЕМ браузере телефона, не во встроенном браузере
// Telegram — именно для этого Telegram.WebApp.openLink() и существует
// (см. https://core.telegram.org/bots/webapps): открывает ссылку в браузере
// по умолчанию, само мини-приложение не закрывается, выбор браузера не
// предлагается. Вне Telegram (например, при разработке через ?u=) — просто
// открывает новую вкладку.
function openTablo() {
  var base = location.href.split('?')[0].split('#')[0];
  var dir = base.substring(0, base.lastIndexOf('/') + 1);
  var tabloUrl = dir + 'tablo.html';
  if (tg && tg.openLink) tg.openLink(tabloUrl);
  else window.open(tabloUrl, '_blank');
}

function reopenBusiness(btn) {
  withButtonLoading(btn, 'Открываем дело…', function () {
    return apiPost('reopenBusiness', myUsername, {})
      .then(function (res) {
        if (res.ok) { alert('Новое дело открыто! Стартовый капитал: ' + fmtMoney(res.cash)); loadPlayerDashboard(); }
        else if (res.error === 'busy') alert('Ведущий прямо сейчас считает месяц. Нажмите ещё раз через несколько секунд.');
        else alert('Не удалось открыть дело: ' + res.error);
      })
      .catch(function (err) { alert('Ошибка: ' + err.message); });
  });
}

function dismissBankBanner() {
  document.getElementById('bank-banner').classList.add('hidden');
  apiPost('markBankRead', myUsername, {});
}

// ------------------------------------------------------------ АДМИН: UI

function loadAdminMonitor(force) {
  releaseStuckMutations_();
  if (!force && Date.now() - lastStateAppliedAt < STATE_FRESH_MS) return Promise.resolve();
  // Та же защита, что и в кабинете игрока (см. блок про viewSeq выше):
  // пульт ведущего опрашивается так же часто и точно так же мог
  // получить устаревший ответ поверх свежего «Открыть месяц».
  if (pendingMutations > 0) return Promise.resolve();

  var seq = ++viewSeq;
  var gen = actionGeneration;

  return apiGet('monitor', { u: myUsername })
    .then(function (d) {
      if (seq <= lastRenderedSeq) return;
      if (gen !== actionGeneration) return;
      lastRenderedSeq = seq;
      renderAdminMonitor(d);
    })
    .catch(function (err) { reportLoadError_(err); });
}

// Ход месяца поллится, но пока действие ведущего в полёте — опрос
// заблокирован (см. loadAdminMonitor), поэтому «Открыть месяц» и
// «Рассчитать» больше не откатываются на экране устаревшим ответом.
var STATUS_LABELS = {
  active: 'активен', bankrupt: 'банкрот (выбирает)',
  civil_service: 'госслужба', freelance: 'своб. плавание', custom_employed: 'своя профессия',
  left: 'вышел из игры'
};

function renderAdminMonitor(d) {
  if (!d.ok) { showError('Ошибка загрузки данных.'); return; }
  document.getElementById('a-round').textContent = 'Месяц ' + d.round.number + ' из ' + d.round.totalRounds +
    (d.round.gameFinished ? ' · игра завершена' : ' · ' + (d.round.status === 'open' ? 'приём решений открыт' : 'закрыт'));

  var body = document.getElementById('admin-monitor-body');
  body.innerHTML = '';
  d.players.forEach(function (p) {
    // v3.2. У игрока вне бизнеса деньги лежат не в кассе (там ноль по
    // определению), а в накоплениях — раньше монитор показывал ему ноль,
    // и это выглядело как «всё обнулилось при смене деятельности».
    // Сервер теперь отдаёт в cash именно ту сумму, которая у него есть;
    // здесь только помечаем, что это накопления, а не касса заведения.
    var cashCell = fmtMoney(p.cash) + (p.offBusiness ? ' <span class="cell-note">накопления</span>' : '');

    // Бренд/ёмкость/банк у игрока без бизнеса не существуют — прочерк
    // честнее нуля, который читался как «всё сгорело».
    var dash = '<span class="cell-na">—</span>';

    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td>' + p.restaurant + '</td>' +
      '<td>' + cashCell + '</td>' +
      '<td>' + (p.brand === null ? dash : p.brand) + '</td>' +
      '<td>' + (p.capacity === null ? dash : p.capacity.toLocaleString('ru-RU')) + '</td>' +
      '<td>' + (p.loanTier === null ? dash : p.loanTier) + '</td>' +
      '<td>' + (STATUS_LABELS[p.status] || p.status) + '</td>' +
      '<td class="' + (p.submitted === null ? '' : (p.submitted ? 'ok' : 'pending')) + '">' +
        (p.submitted === null ? dash : (p.submitted ? '✓' : '…')) + '</td>' +
      '<td class="' + (p.joined ? 'ok' : 'pending') + '">' + (p.joined ? '✓' : '…') + '</td>';
    body.appendChild(tr);
  });

  startCountdown(d.round.status === 'open' ? d.round.deadline : null, ['a-timer']);
}

function adminOpenRound(btn) {
  withButtonLoading(btn, 'Открываем…', function () {
    return apiPost('adminOpenRound', myUsername, {})
      .then(function (res) {
        if (res.ok) { loadAdminMonitor(); return; }
        var messages = {
          already_open: 'Месяц уже открыт.',
          game_finished: 'Игра уже завершена (достигнут лимит месяцев). Чтобы начать заново — «Опасная зона» ниже.'
        };
        alert(messages[res.error] || ('Не удалось открыть месяц: ' + res.error));
      })
      .catch(function (err) { alert('Ошибка: ' + err.message); });
  });
}

function adminCalculateRound(btn) {
  if (!confirm('Рассчитать месяц? Приём решений будет закрыт.')) return;
  withButtonLoading(btn, 'Считаем…', function () {
    return apiPost('adminCalculateRound', myUsername, {})
      .then(function (res) {
        if (res.ok) { alert('Месяц рассчитан.'); loadAdminMonitor(); }
        else alert('Не удалось рассчитать: ' + res.error);
      })
      .catch(function (err) { alert('Ошибка: ' + err.message); });
  });
}

// ------------------------------------------------------------ СБРОС ИГРЫ

function revealResetConfirm() {
  document.getElementById('reset-confirm-block').classList.remove('hidden');
  document.getElementById('reset-reveal-btn').classList.add('hidden');
}

function cancelResetConfirm() {
  document.getElementById('reset-confirm-block').classList.add('hidden');
  document.getElementById('reset-reveal-btn').classList.remove('hidden');
  document.getElementById('reset-confirm-input').value = '';
}

function confirmResetGame(btn) {
  var text = document.getElementById('reset-confirm-input').value;
  if (!text) { alert('Введите код игры (см. лист Config → GAME_CODE).'); return; }
  withButtonLoading(btn, 'Сбрасываем…', function () {
    return apiPost('adminResetGame', myUsername, { confirmText: text })
      .then(function (res) {
        if (res.ok) {
          alert('Игра сброшена. Можно начинать заново с месяца 1.');
          cancelResetConfirm();
          loadAdminMonitor();
        } else {
          var messages = { confirmation_mismatch: 'Код игры не совпадает — сброс отменён.' };
          alert(messages[res.error] || ('Не удалось сбросить: ' + res.error));
        }
      })
      .catch(function (err) { alert('Ошибка: ' + err.message); });
  });
}

boot();
