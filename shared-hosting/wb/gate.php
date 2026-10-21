<?php
require_once __DIR__ . '/auth-guard.php';

$asset = isset($_GET['asset']) && $_GET['asset'] !== '' ? $_GET['asset'] : 'index.html';
if ($asset === 'api.php') {
    require __DIR__ . '/api.php';
    exit;
}
$assets = array(
    'index.html' => 'text/html; charset=utf-8',
    'renderer.js' => 'text/javascript; charset=utf-8',
    'styles.css' => 'text/css; charset=utf-8',
);
if (!isset($assets[$asset])) {
    http_response_code(404);
    exit;
}
$file = __DIR__ . '/' . $asset;
if (!is_file($file)) {
    http_response_code(404);
    exit;
}
header('Content-Type: ' . $assets[$asset]);
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: no-referrer');
readfile($file);
