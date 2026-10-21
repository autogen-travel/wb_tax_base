<?php
function wbRequireBasicAuth() {
    $config = @include __DIR__ . '/.wb-auth.php';
    $username = isset($_SERVER['PHP_AUTH_USER']) ? $_SERVER['PHP_AUTH_USER'] : '';
    $password = isset($_SERVER['PHP_AUTH_PW']) ? $_SERVER['PHP_AUTH_PW'] : '';
    if ($username === '' && isset($_SERVER['HTTP_AUTHORIZATION'])) {
        $authorization = $_SERVER['HTTP_AUTHORIZATION'];
        if (stripos($authorization, 'Basic ') === 0) {
            $decoded = base64_decode(substr($authorization, 6), true);
            if ($decoded !== false && strpos($decoded, ':') !== false) {
                list($username, $password) = explode(':', $decoded, 2);
            }
        }
    }
    $valid = is_array($config)
        && isset($config['username'], $config['password_hash'])
        && $username !== ''
        && hash_equals($config['username'], $username)
        && $password !== ''
        && password_verify($password, $config['password_hash']);
    if (!$valid) {
        header('WWW-Authenticate: Basic realm="WB Reports", charset="UTF-8"');
        header('Cache-Control: no-store');
        http_response_code(401);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(array('error' => 'Требуется Basic Auth для доступа к приложению.'), JSON_UNESCAPED_UNICODE);
        exit;
    }
}

wbRequireBasicAuth();
