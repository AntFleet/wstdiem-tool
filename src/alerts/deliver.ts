import chalk from "chalk";
import { request } from "undici";
import type { AlertEvaluation, AppConfig } from "../types/domain.js";

export interface AlertPayload {
  severity: string;
  alertKey: string;
  message: string;
  metrics: Record<string, unknown>;
  suggestedAction: string;
  chainId: number;
  blockNumber: string;
  timestamp: number;
}

export function toPayload(alert: AlertEvaluation, config: AppConfig, blockNumber: bigint, timestamp: number): AlertPayload {
  return {
    severity: alert.level,
    alertKey: alert.alertKey,
    message: alert.message,
    metrics: alert.metrics,
    suggestedAction: alert.suggestedAction,
    chainId: config.chainId,
    blockNumber: blockNumber.toString(),
    timestamp,
  };
}

export function writeAlertToStderr(alert: AlertEvaluation): void {
  const line = `[${alert.level}] ${alert.message} ${alert.suggestedAction}`;
  if (alert.level === "CRITICAL") {
    console.error(chalk.red.bold(line));
  } else if (alert.level === "WARN") {
    console.error(chalk.yellow(line));
  } else {
    console.error(chalk.blue(line));
  }
}

function channelLabel(url: string, index: number): string {
  let host = "webhook";
  try {
    host = new URL(url).host;
  } catch {
    host = "invalid-webhook";
  }
  return `webhook:${host}#${index + 1}`;
}

export async function sendWebhook(url: string, payload: AlertPayload): Promise<void> {
  const response = await request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Webhook returned HTTP ${response.statusCode}`);
  }
}

function telegramText(payload: AlertPayload): string {
  return [
    `[${payload.severity}] ${payload.alertKey}`,
    payload.message,
    payload.suggestedAction,
    `chainId=${payload.chainId} block=${payload.blockNumber}`,
  ].join("\n");
}

export async function sendTelegram(botToken: string, chatId: string, payload: AlertPayload): Promise<void> {
  const response = await request(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: telegramText(payload),
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Telegram returned HTTP ${response.statusCode}`);
  }
}

export async function deliverConfiguredAlerts(
  config: AppConfig,
  alerts: AlertEvaluation[],
  blockNumber: bigint,
  timestamp: number,
): Promise<string[]> {
  const delivered: string[] = [];
  for (const alert of alerts) {
    writeAlertToStderr(alert);
    delivered.push("stderr");
    const payload = toPayload(alert, config, blockNumber, timestamp);
    for (const [index, url] of config.alerts.webhookUrls.entries()) {
      const label = channelLabel(url, index);
      try {
        await sendWebhook(url, payload);
        delivered.push(`${label}:delivered`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        delivered.push(`${label}:failed:${message}`);
        console.error(chalk.yellow(`[WARN] Alert delivery failed for ${label}: ${message}`));
      }
    }
    if (config.alerts.telegram.chatId !== null) {
      const label = "telegram";
      const token = process.env[config.alerts.telegram.botTokenEnv];
      try {
        if (token === undefined || token.trim() === "") {
          throw new Error(`missing bot token env ${config.alerts.telegram.botTokenEnv}`);
        }
        await sendTelegram(token, config.alerts.telegram.chatId, payload);
        delivered.push(`${label}:delivered`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        delivered.push(`${label}:failed:${message}`);
        console.error(chalk.yellow(`[WARN] Alert delivery failed for ${label}: ${message}`));
      }
    }
  }
  return delivered;
}
