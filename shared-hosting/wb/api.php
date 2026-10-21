<?php
// Same-origin proxy and shared cabinet store for the Wildberries Finance API.
// Requests are authenticated by auth-guard.php before reaching this endpoint.

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: no-referrer');

function respond($status, $payload) {
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    header('Allow: POST');
    respond(405, array('error' => 'Разрешён только POST запрос.'));
}

$raw = file_get_contents('php://input');
if ($raw === false || strlen($raw) > 32768) respond(413, array('error' => 'Слишком большой запрос.'));
$body = json_decode($raw, true);
if (!is_array($body)) respond(400, array('error' => 'Некорректный JSON запрос.'));
$action = isset($body['action']) && is_string($body['action']) ? $body['action'] : 'report';

// Store data in a PHP file whose first instructions exit before its JSON payload.
// Direct HTTP access therefore executes the guard and never returns stored tokens.
function accountStore($writeData = null) {
    $path = __DIR__ . '/.wb-accounts.php';
    $guard = "<?php http_response_code(404); exit; __halt_compiler(); ?>\n";
    $handle = @fopen($path, 'c+');
    if (!$handle) respond(500, array('error' => 'Не удалось открыть хранилище кабинетов.'));
    if (!flock($handle, LOCK_EX)) {
        fclose($handle);
        respond(500, array('error' => 'Не удалось заблокировать хранилище кабинетов.'));
    }
    rewind($handle);
    $contents = stream_get_contents($handle);
    $accounts = array();
    if ($contents && strpos($contents, $guard) === 0) {
        $decoded = json_decode(substr($contents, strlen($guard)), true);
        if (is_array($decoded)) $accounts = $decoded;
    }
    if ($writeData !== null) {
        $encoded = json_encode($writeData, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        rewind($handle);
        if (!ftruncate($handle, 0) || fwrite($handle, $guard . $encoded) === false || !fflush($handle)) {
            flock($handle, LOCK_UN);
            fclose($handle);
            respond(500, array('error' => 'Не удалось записать хранилище кабинетов.'));
        }
        @chmod($path, 0600);
        $accounts = $writeData;
    }
    flock($handle, LOCK_UN);
    fclose($handle);
    return $accounts;
}

function lockAccountStore() {
    static $lockHandle = null;
    if ($lockHandle !== null) return;
    $lockHandle = @fopen(__DIR__ . '/.wb-accounts.lock', 'c');
    if (!$lockHandle || !flock($lockHandle, LOCK_EX)) respond(500, array('error' => 'Не удалось заблокировать хранилище кабинетов.'));
    @chmod(__DIR__ . '/.wb-accounts.lock', 0600);
    register_shutdown_function(function () use (&$lockHandle) {
        if (is_resource($lockHandle)) {
            flock($lockHandle, LOCK_UN);
            fclose($lockHandle);
        }
    });
}

function newAccountId() {
    if (!function_exists('openssl_random_pseudo_bytes')) respond(500, array('error' => 'На хостинге не включено расширение OpenSSL.'));
    $strong = false;
    $bytes = openssl_random_pseudo_bytes(16, $strong);
    if ($bytes === false || !$strong) respond(500, array('error' => 'Не удалось создать безопасный ID кабинета.'));
    return bin2hex($bytes);
}

function publicAccounts($accounts) {
    $result = array();
    foreach ($accounts as $account) {
        if (isset($account['id'], $account['name'], $account['token'])) {
            $result[] = array('id' => $account['id'], 'name' => $account['name'], 'hasToken' => true);
        }
    }
    return $result;
}

$accounts = accountStore();
if ($action === 'listAccounts') respond(200, publicAccounts($accounts));
if ($action === 'saveAccount') {
    lockAccountStore();
    $accounts = accountStore();
    $id = isset($body['id']) && is_string($body['id']) ? $body['id'] : '';
    $name = isset($body['name']) && is_string($body['name']) ? trim($body['name']) : '';
    $token = isset($body['token']) && is_string($body['token']) ? trim($body['token']) : '';
    if ($name === '' || strlen($name) > 120) respond(400, array('error' => 'Укажите название кабинета (до 120 символов).'));
    $found = false;
    foreach ($accounts as &$account) {
        if ($id !== '' && isset($account['id']) && hash_equals((string)$account['id'], $id)) {
            $account['name'] = $name;
            if ($token !== '') $account['token'] = $token;
            $found = true;
            break;
        }
    }
    unset($account);
    if (!$found) {
        if (strlen($token) < 10 || strlen($token) > 4096 || preg_match('/[\r\n]/', $token)) respond(400, array('error' => 'Для нового кабинета нужен корректный токен категории «Финансы».'));
        $accounts[] = array('id' => newAccountId(), 'name' => $name, 'token' => $token);
    } elseif ($token !== '' && (strlen($token) < 10 || strlen($token) > 4096 || preg_match('/[\r\n]/', $token))) {
        respond(400, array('error' => 'Проверьте токен категории «Финансы».'));
    }
    accountStore($accounts);
    respond(200, publicAccounts($accounts));
}
if ($action === 'deleteAccount') {
    lockAccountStore();
    $accounts = accountStore();
    $id = isset($body['id']) && is_string($body['id']) ? $body['id'] : '';
    if ($id === '') respond(400, array('error' => 'Не указан кабинет.'));
    $accounts = array_values(array_filter($accounts, function ($account) use ($id) {
        return !isset($account['id']) || !hash_equals((string)$account['id'], $id);
    }));
    accountStore($accounts);
    respond(200, publicAccounts($accounts));
}
if ($action !== 'report') respond(400, array('error' => 'Неизвестный тип запроса.'));

$accountId = isset($body['accountId']) && is_string($body['accountId']) ? $body['accountId'] : '';
$token = '';
foreach ($accounts as $account) {
    if ($accountId !== '' && isset($account['id'], $account['token']) && hash_equals((string)$account['id'], $accountId)) {
        $token = $account['token'];
        break;
    }
}
$dateFrom = isset($body['dateFrom']) && is_string($body['dateFrom']) ? $body['dateFrom'] : '';
$dateTo = isset($body['dateTo']) && is_string($body['dateTo']) ? $body['dateTo'] : '';
$period = isset($body['period']) && is_string($body['period']) ? $body['period'] : 'daily';
$limit = isset($body['limit']) ? (int)$body['limit'] : 99000;
$rrdid = isset($body['rrdid']) ? (int)$body['rrdid'] : 0;
$datePattern = '/^\d{4}-\d{2}-\d{2}$/';
if ($token === '') respond(404, array('error' => 'Кабинет не найден или в нём нет токена.'));
if (!preg_match($datePattern, $dateFrom) || !preg_match($datePattern, $dateTo)) {
    respond(400, array('error' => 'Нужны даты начала и окончания периода в формате YYYY-MM-DD.'));
}
$fromDate = DateTime::createFromFormat('!Y-m-d', $dateFrom);
$toDate = DateTime::createFromFormat('!Y-m-d', $dateTo);
if (!$fromDate || $fromDate->format('Y-m-d') !== $dateFrom || !$toDate || $toDate->format('Y-m-d') !== $dateTo || $dateFrom > $dateTo) {
    respond(400, array('error' => 'Неверный диапазон дат.'));
}
if (!in_array($period, array('daily', 'weekly'), true)) respond(400, array('error' => 'Период должен быть daily или weekly.'));
if (!function_exists('curl_init')) respond(500, array('error' => 'На хостинге не включено PHP расширение cURL.'));

$payload = json_encode(array(
    'dateFrom' => $dateFrom,
    'dateTo' => $dateTo,
    'limit' => max(1, min($limit > 0 ? $limit : 99000, 100000)),
    'rrdId' => max($rrdid, 0),
    'period' => $period,
));
$curl = curl_init('https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed');
curl_setopt_array($curl, array(
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => $payload,
    CURLOPT_HTTPHEADER => array('Authorization: ' . $token, 'Content-Type: application/json', 'Accept: application/json'),
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_CONNECTTIMEOUT => 15,
    CURLOPT_TIMEOUT => 100,
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_SSL_VERIFYHOST => 2,
));
$responseBody = curl_exec($curl);
$curlError = curl_error($curl);
$status = (int)curl_getinfo($curl, CURLINFO_HTTP_CODE);
curl_close($curl);
if ($responseBody === false) respond(502, array('error' => 'Не удалось связаться с API Wildberries: ' . $curlError));
if ($status === 204) {
    http_response_code(204);
    exit;
}
http_response_code($status > 0 ? $status : 502);
header('Content-Type: application/json; charset=utf-8');
echo $responseBody;
