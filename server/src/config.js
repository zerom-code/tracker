/* Конфигурация целиком из переменных окружения — никаких секретов в коде. */

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[config] не задана обязательная переменная ${name}`);
    process.exit(1);
  }
  return v;
}

export const config = {
  port: Number(process.env.PORT || 8090),
  host: process.env.HOST || '0.0.0.0', // внутри контейнера; наружу выставляет Caddy

  // длинный случайный токен, который вводится в приложении один раз
  deviceToken: required('DEVICE_TOKEN'),
  // случайный сегмент пути вебхука: /hook/<secret>
  webhookSecret: required('WEBHOOK_SECRET'),
  // публичный адрес сервиса, напр. https://tracker.your-domain.com
  publicUrl: required('PUBLIC_URL').replace(/\/+$/, ''),

  // ключи Web Push (сгенерировать: npm run vapid)
  vapidPublic: process.env.VAPID_PUBLIC || '',
  vapidPrivate: process.env.VAPID_PRIVATE || '',
  vapidSubject: process.env.VAPID_SUBJECT || 'mailto:tracker@example.com',

  // источник приложения, которому разрешён доступ к API (CORS)
  allowedOrigins: (process.env.ALLOWED_ORIGINS || 'https://zerom-code.github.io')
    .split(',').map((s) => s.trim()).filter(Boolean),

  dataDir: process.env.DATA_DIR || '/data',
};

export const webhookPath = '/hook/' + config.webhookSecret;
export const webhookUrl = config.publicUrl + webhookPath;
