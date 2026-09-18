import type { SqliteStore } from "../../db/sqlite";
import type { Command } from "commander";
import {
  countInvoicesMissingNotification,
  markInvoicesMissingNotification,
} from "../../db/repository";
import { ConfigError } from "../../utils/errors";
import { ensureInitialized } from "../bootstrap";
import { createContext } from "../context";
import { promptText } from "../prompt";
import { printHeader, printKeyValues } from "../ui";
import { runCommand, type RootOptions } from "./runCommand";

const unpaidDueNotificationKind = "unpaid_due";

type BackfillOptions = {
  dryRun?: boolean;
  yes?: boolean;
};

export type NotificationBackfillResult = {
  candidates: number;
  marked: number;
};

export const backfillUnpaidInvoiceNotifications = async (
  store: SqliteStore,
  dryRun: boolean,
): Promise<NotificationBackfillResult> =>
  store.withDb((db) => {
    const candidates = countInvoicesMissingNotification(
      db,
      unpaidDueNotificationKind,
    );
    if (dryRun || candidates === 0) {
      return { candidates, marked: 0 };
    }

    const marked = markInvoicesMissingNotification(
      db,
      unpaidDueNotificationKind,
      new Date().toISOString(),
    );
    return { candidates, marked };
  });

const printResult = (
  status: "cancelled" | "completed" | "dry run",
  result: NotificationBackfillResult,
): void => {
  printHeader("Notification Backfill");
  printKeyValues([
    ["status", status],
    ["candidates", result.candidates],
    ["marked", result.marked],
  ]);
};

export function registerSystemNotifications(
  system: Command,
  program: Command,
): void {
  const notifications = system
    .command("notifications")
    .description("Manage notification state");

  notifications
    .command("backfill")
    .description("Mark existing invoices as notification-handled without sending")
    .option("--dry-run", "show how many invoices would be marked")
    .option("--yes", "skip confirmation prompt")
    .action(
      runCommand(async (options: BackfillOptions) => {
        const rootOpts = program.opts<RootOptions>();
        await ensureInitialized(rootOpts.config);
        const ctx = await createContext(rootOpts.config, {
          verbose: rootOpts.verbose,
        });
        const preview = await backfillUnpaidInvoiceNotifications(
          ctx.store,
          true,
        );

        if (options.dryRun) {
          printResult("dry run", preview);
          return;
        }
        if (preview.candidates === 0) {
          printResult("completed", preview);
          return;
        }

        if (!options.yes) {
          if (!process.stdin.isTTY) {
            throw new ConfigError(
              "Notification backfill requires confirmation; rerun with --yes in non-interactive mode.",
            );
          }
          const answer = await promptText(
            `Mark ${preview.candidates} invoice notification(s) as already handled without sending? (y/N): `,
          );
          if (!/^y(es)?$/i.test(answer)) {
            printResult("cancelled", preview);
            return;
          }
        }

        const result = await backfillUnpaidInvoiceNotifications(
          ctx.store,
          false,
        );
        printResult("completed", result);
      }),
    );
}
