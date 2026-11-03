/** Obviously fake credentials used only by isolated tests; never used against services. */
export const foundationEnv = {
  MONGODB_URI: 'mongodb://localhost:27017/test',
  REDIS_URL: 'redis://localhost:6379',
  OPERATOR_API_KEY: 'placeholder-operator-test-only',
  OPERATOR_USERNAME: 'fixture-operator',
  OPERATOR_PASSWORD: 'placeholder-operator-password',
  SESSION_SECRET: 'placeholder-session-secret-at-least-32-characters',
  MONGO_ROOT_USERNAME: 'fixture-root',
  MONGO_ROOT_PASSWORD: 'placeholder-mongo-password',
  REDIS_PASSWORD: 'placeholder-redis-password',
  KEY_ENCRYPTION_SECRET: 'placeholder-encryption-secret-at-least-32-characters',
};
