import { z } from "zod";

export const EnvironmentSchema = z.enum(["test", "prod"]);
export type Environment = z.infer<typeof EnvironmentSchema>;

export const SubjectTypeSchema = z.enum([
  "Subject1",
  "Subject2",
  "Subject3",
  "SubjectAuthorized",
]);
export type SubjectType = z.infer<typeof SubjectTypeSchema>;

const AuthorizationPolicySchema = z
  .object({
    allowedIps: z
      .object({
        ip4Addresses: z.array(z.string()).optional(),
        ip4Masks: z.array(z.string()).optional(),
        ip4Ranges: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .optional();

const AuthSchema = z.object({
  method: z.literal("ksefToken").default("ksefToken"),
  authorizationPolicy: AuthorizationPolicySchema,
  keychainServiceName: z.string().optional(),
});

const SmtpSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive(),
  user: z.string().min(1),
  pass: z.string().min(1),
  from: z.string().min(1),
  to: z.array(z.string().min(1)).min(1),
  secure: z.boolean().default(false),
  tlsRejectUnauthorized: z.boolean().default(true),
});

const SmtpProfileSchema = SmtpSchema.extend({
  label: z.string().min(1),
  nips: z.array(z.string().regex(/^\d{10}$/)).default([]),
});

const NotificationSchema = z.object({
  macosNotification: z.boolean().default(true),
  unpaidInvoiceCatchUp: z.boolean().default(false),
  email: z
    .object({
      enabled: z.boolean().default(false),
      smtp: SmtpSchema.optional(),
      smtpProfiles: z.array(SmtpProfileSchema).optional(),
    })
    .default({ enabled: false }),
});

const LoggingSchema = z.object({
  level: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  file: z.string().min(1),
  pretty: z.boolean().default(false),
});

const RetrySchema = z.object({
  maxAttempts: z.number().int().min(1).default(5),
  baseDelayMs: z.number().int().min(100).default(500),
  maxDelayMs: z.number().int().min(100).default(10_000),
  jitter: z.number().min(0).max(1).default(0.2),
});

const OperationalSchema = z.object({
  maxConcurrency: z.number().int().min(1).default(2),
  timeoutSeconds: z.number().int().min(5).default(60),
  pollIntervalSeconds: z.number().int().min(5).default(10),
  authPollMaxAttempts: z.number().int().min(1).default(60),
  exportPollMaxAttempts: z.number().int().min(1).default(120),
  exportCooldownSeconds: z.number().int().min(0).default(2),
  allowInsecureHttp: z.boolean().default(false),
  retry: RetrySchema.default({}),
});

const SecuritySchema = z.object({
  tls: z
    .object({
      enablePinning: z.boolean().default(false),
      pins: z.array(z.string().min(10)).default([]),
      pinningHosts: z.array(z.string().min(1)).default([]),
      caPath: z.string().optional(),
    })
    .default({ enablePinning: false, pins: [], pinningHosts: [] }),
  allowedHosts: z.array(z.string().min(1)).default([]),
});

const SyncSchema = z.object({
  subjectTypes: z
    .array(SubjectTypeSchema)
    .default(["Subject1", "Subject2", "Subject3", "SubjectAuthorized"]),
  includeMetadataHeader: z.boolean().default(true),
  generatePdf: z.boolean().default(true),
  flatSync: z.boolean().default(false),
  initialSyncFrom: z.string().datetime().optional(),
  maxConcurrentNips: z.number().int().min(1).default(1),
});

export const AppConfigSchema = z.object({
  environment: EnvironmentSchema.default("prod"),
  apiBaseUrl: z.string().url().optional(),
  auth: AuthSchema,
  organizations: z
    .array(
      z.object({
        nip: z.string().regex(/^\d{10}$/),
        label: z.string().optional(),
        outputPath: z.string().min(1).optional(),
      }),
    )
    .default([]),
  pollingIntervalSeconds: z.number().int().min(30).default(300),
  storage: z.object({
    root: z.string().min(1),
  }),
  notifications: NotificationSchema.default({
    macosNotification: true,
    unpaidInvoiceCatchUp: false,
    email: { enabled: false },
  }),
  logging: LoggingSchema,
  operational: OperationalSchema.default({}),
  security: SecuritySchema.default({}),
  sync: SyncSchema.default({}),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
