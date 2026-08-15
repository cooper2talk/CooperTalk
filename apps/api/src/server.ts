import "dotenv/config";
import { loadConfig } from "./config.js";
import { PostgresRepository } from "./repository.js";
import { createApp } from "./app.js";

const config = loadConfig();
if (!config.DATABASE_URL) throw new Error("DATABASE_URL is required outside tests");
const app = await createApp(new PostgresRepository(config.DATABASE_URL), config);
await app.listen({ host: "0.0.0.0", port: config.PORT });
