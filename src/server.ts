import "dotenv/config";

import app from "./app";
import { testConnection } from "./config/db";
import { testRedisConnection } from "./config/redis";
import { initKeyring } from "./security/keyring";

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    // Validate required environment variables
    const required = [
      "DATABASE_URL",
      "SUPABASE_URL",
      "SUPABASE_KEY",
      "REDIS_URL",
      "ENCRYPTION_KEY",
    ];
    for (const key of required) {
      if (!process.env[key]) {
        throw new Error(`Missing required environment variable: ${key}`);
      }
    }

    // Initialise encryption key ring before any token reads/writes.
    initKeyring();

    // Test external connections
    await testConnection(); // PostgreSQL
    await testRedisConnection(); // Redis (Upstash)

    app.listen(PORT, () => {
      console.log(`\n🚀 Server running on http://localhost:${PORT}`);
      console.log(`   Health: http://localhost:${PORT}/health`);
      console.log(
        `   Auth:   http://localhost:${PORT}/api/v1/auth/google?token=<JWT>`,
      );
      console.log(`   Events: http://localhost:${PORT}/api/v1/events\n`);
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
};

startServer();
