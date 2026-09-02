import { PostgresEngineVersion } from "aws-cdk-lib/aws-rds";
import { InstanceClass, InstanceSize } from "aws-cdk-lib/aws-ec2";
import * as fs from "fs";

export interface Config {
  accountId: string;
  region: string;
  vpcCidr: string;
  publicUrl: string;
  hostName: string;
  hostZone: string;
  certificateArn: string;
  containerImage: string;
  dbName: string;
  dbUser: string;
  postgresVersion: PostgresEngineVersion;
  dbInstanceSize: InstanceSize;
  dbInstanceClass: InstanceClass;
  oidcClientSecretArn: string;
  natGatewayCount: number;
  deployEnvironment: string;
  dbRetention: number;
  remsTokenSecretArn: string;
  ampWorkspaceId: string;
  monitoringAccountId: string;
  project?: string;
  owner?: string;
  monitoringPrometheusRole?: string;
  requestorUrl: string;
  webhookSecretArn: string;  // Full ARN of rems/webhook-secret in Secrets Manager
  // --- Observability (workload side) ---
  monitoringOamSinkId?: string;   // OAM sink ARN in the central monitoring account; enables the OAM link
  adotCollectorImage?: string;    // pin the ADOT collector image (prefer a digest)
  jmxAgentUrl?: string;           // source for the JMX Prometheus javaagent jar (prefer an in-account mirror)
  jmxAgentSha256?: string;        // optional checksum; verified when set
  // --- DNS ---
  manageDnsRecord?: boolean;      // default true; false = skip lookup + A-record (manage DNS manually)
  hostedZoneId?: string;          // when managing, use this instead of a name-based lookup
}

/**
 * Build a Config from environment variables (the CI/CD contract).
 *
 * This is the loader thin deployment repos use: their pipeline injects the
 * per-environment secrets/vars (account, CIDR, cert ARN, image, secret ARNs,
 * ...) and this reads them into a typed Config. Projects that prefer static
 * config-as-data can instead construct a Config object directly and pass it to
 * createRemsApp().
 */
export function getConfigFromEnv(): Config {
  const deployEnv = process.env.DEPLOY_ENV || "dev";
  const isProd = deployEnv === "prod" || deployEnv === "production";

  return {
    project: process.env.PROJECT || "ACDC",
    owner: process.env.OWNER || "biocloud",
    deployEnvironment: deployEnv,
    remsTokenSecretArn: process.env.REMS_TOKEN_ARN || "arn:aws:secretmanager:region:account:secret:rems-token-secret",
    oidcClientSecretArn:
      process.env.OIDC_SECRET_ARN ||
      "arn:aws:secretmanager:region:account:secret:rems-oidc-client-secret",
    accountId: process.env.CDK_ACCOUNT_ID || "000000000000",
    region: process.env.CDK_REGION || "ap-southeast-2",
    vpcCidr: process.env.VPC_CIDR || "192.168.0.0/24",
    publicUrl: process.env.PUBLIC_URL || "https://dev-rems.example.org/",
    hostName: process.env.HOST_NAME || "dev-rems.example.org",
    hostZone: process.env.HOST_ZONE || "example.org",
    certificateArn:
      process.env.CERTIFICATE_ARN ||
      "arn:aws:acm:region:account:certificate/dev",
    containerImage: process.env.CONTAINER_IMAGE || "cscfi/rems:latest",
    dbName: process.env.DB_NAME || "rems",
    dbUser: process.env.DB_USER || "rems",
    postgresVersion: getPostgresEngineVersion(
      process.env.POSTGRES_VERSION || "17.4"
    ),
    dbInstanceSize: getDBInstanceSize(
      process.env.DB_INSTANCE_SIZE || "micro"
    ),
    dbInstanceClass: getDBInstanceClass(
      process.env.DB_INSTANCE_CLASS || "burstable3"
    ),
    dbRetention: isProd ? 30 : 7,
    natGatewayCount: isProd ? 3 : 1,
    ampWorkspaceId: process.env.AMP_WORKSPACE_ID || "ws-XXXXXXXX",
    monitoringAccountId: process.env.MONITORING_ACCOUNT_ID || "000000000000",
    monitoringPrometheusRole:
      process.env.MONITORING_PROMETHEUS_ROLE ||
      "arn:aws:iam::123456789012:role/MonitoringAccountPrometheusRole",
    requestorUrl:
      process.env.REQUESTOR_URL || "https://data.test.biocommons.org.au/requestor",
    // Full ARN required — fromSecretCompleteArn needs the suffix (e.g. -4Zbga6)
    // Set WEBHOOK_SECRET_ARN in CI/CD or .env per environment:
    //   aws secretsmanager describe-secret --secret-id rems/webhook-secret | jq '.ARN'
    webhookSecretArn:
      process.env.WEBHOOK_SECRET_ARN ||
      "arn:aws:secretsmanager:ap-southeast-2:000000000000:secret:rems/webhook-secret-??????",
    monitoringOamSinkId: process.env.MONITORING_OAM_SINK_ID,
    adotCollectorImage: process.env.ADOT_COLLECTOR_IMAGE,
    jmxAgentUrl: process.env.JMX_AGENT_URL,
    jmxAgentSha256: process.env.JMX_AGENT_SHA256,
    manageDnsRecord:
      process.env.MANAGE_DNS_RECORD === undefined
        ? undefined
        : process.env.MANAGE_DNS_RECORD !== "false",
    hostedZoneId: process.env.HOSTED_ZONE_ID,
  };
}

/**
 * @deprecated Use getConfigFromEnv(). Kept so existing bin entrypoints and any
 * code importing getConfig keep working unchanged.
 */
export const getConfig = getConfigFromEnv;

/**
 * Shape of a committed per-environment JSON config file. Every field here is
 * NON-SENSITIVE: account IDs, DNS names, and ARNs (which are references, not
 * secret material). The actual secrets live in Secrets Manager and are pointed
 * at by the *SecretArn fields — never put secret values in this file.
 *
 * `deployRoleArn` is read by CI (for the OIDC assume-role step), not by the
 * app; it is ignored when mapping to Config.
 */
export interface RawConfig {
  accountId: string;
  region: string;
  vpcCidr: string;
  publicUrl: string;
  hostName: string;
  hostZone: string;
  certificateArn: string;
  containerImage: string;
  deployEnvironment: string;
  oidcClientSecretArn: string;
  remsTokenSecretArn: string;
  webhookSecretArn: string;
  requestorUrl: string;
  dbName?: string;
  dbUser?: string;
  postgresVersion?: string;
  dbInstanceSize?: string;
  dbInstanceClass?: string;
  dbRetention?: number;
  natGatewayCount?: number;
  ampWorkspaceId?: string;
  monitoringAccountId?: string;
  monitoringPrometheusRole?: string;
  project?: string;
  owner?: string;
  deployRoleArn?: string; // CI-only (OIDC assume-role); ignored by the app.
  monitoringOamSinkId?: string;
  adotCollectorImage?: string;
  jmxAgentUrl?: string;
  jmxAgentSha256?: string;
  manageDnsRecord?: boolean;
  hostedZoneId?: string;
}

/** Map a plain JSON config object to a typed Config. */
export function configFromJson(raw: RawConfig): Config {
  const deployEnv = raw.deployEnvironment;
  const isProd = deployEnv === "prod" || deployEnv === "production";

  return {
    project: raw.project ?? "ACDC",
    owner: raw.owner ?? "biocloud",
    deployEnvironment: deployEnv,
    accountId: raw.accountId,
    region: raw.region,
    vpcCidr: raw.vpcCidr,
    publicUrl: raw.publicUrl,
    hostName: raw.hostName,
    hostZone: raw.hostZone,
    certificateArn: raw.certificateArn,
    containerImage: raw.containerImage,
    dbName: raw.dbName ?? "rems",
    dbUser: raw.dbUser ?? "rems",
    postgresVersion: getPostgresEngineVersion(raw.postgresVersion ?? "17.4"),
    dbInstanceSize: getDBInstanceSize(raw.dbInstanceSize ?? "micro"),
    dbInstanceClass: getDBInstanceClass(raw.dbInstanceClass ?? "burstable3"),
    dbRetention: raw.dbRetention ?? (isProd ? 30 : 7),
    natGatewayCount: raw.natGatewayCount ?? (isProd ? 3 : 1),
    oidcClientSecretArn: raw.oidcClientSecretArn,
    remsTokenSecretArn: raw.remsTokenSecretArn,
    webhookSecretArn: raw.webhookSecretArn,
    ampWorkspaceId: raw.ampWorkspaceId ?? "ws-XXXXXXXX",
    monitoringAccountId: raw.monitoringAccountId ?? "000000000000",
    monitoringPrometheusRole: raw.monitoringPrometheusRole,
    requestorUrl: raw.requestorUrl,
    monitoringOamSinkId: raw.monitoringOamSinkId,
    adotCollectorImage: raw.adotCollectorImage,
    jmxAgentUrl: raw.jmxAgentUrl,
    jmxAgentSha256: raw.jmxAgentSha256,
    manageDnsRecord: raw.manageDnsRecord,
    hostedZoneId: raw.hostedZoneId,
  };
}

/** Load and map a committed per-environment JSON config file. */
export function getConfigFromFile(filePath: string): Config {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as RawConfig;
  return configFromJson(raw);
}

export function getPostgresEngineVersion(version: string): PostgresEngineVersion {
  switch (version) {
    case "13.20": return PostgresEngineVersion.VER_13_20;
    case "14.9": return PostgresEngineVersion.VER_14_9;
    case "15.9": return PostgresEngineVersion.VER_15_9;
    case "16.8": return PostgresEngineVersion.VER_16_8;
    case "17.4": return PostgresEngineVersion.VER_17_4;
    default: throw new Error(`Unsupported Postgres version: ${version}`);
  }
}

export function getDBInstanceSize(size: string): InstanceSize {
  switch (size.toLowerCase()) {
    case "micro": return InstanceSize.MICRO;
    case "small": return InstanceSize.SMALL;
    case "medium": return InstanceSize.MEDIUM;
    case "large": return InstanceSize.LARGE;
    default: throw new Error(`Unsupported Postgres Instance size: ${size}`);
  }
}

export function getDBInstanceClass(cls: string): InstanceClass {
  switch (cls.toLowerCase()) {
    case "burstable2": return InstanceClass.BURSTABLE2;
    case "burstable3": return InstanceClass.BURSTABLE3;
    case "memory": return InstanceClass.MEMORY5;
    default: throw new Error(`Unsupported DB instance class: ${cls}`);
  }
}