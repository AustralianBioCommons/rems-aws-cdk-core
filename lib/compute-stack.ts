import { Stack, StackProps, Duration, RemovalPolicy, CfnOutput } from "aws-cdk-lib";
import { Construct } from "constructs";
import { ISecret, Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Vpc, SubnetType, SecurityGroup, Port, Peer } from "aws-cdk-lib/aws-ec2";
import {
  Cluster,
  FargateTaskDefinition,
  ContainerImage,
  Secret as ECSSecret,
  FargateService,
  LogDriver,
  PortMapping,
  AwsLogDriverMode,
  PropagatedTagSource,
  Protocol,
  ContainerDependencyCondition
} from "aws-cdk-lib/aws-ecs";
import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ApplicationProtocolVersion,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Config } from "../config/config";
import { Effect, ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import * as iam from "aws-cdk-lib/aws-iam";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";

interface ComputeStackProps extends StackProps {
  vpc: Vpc;
  config: Config;
}

export class ComputeStack extends Stack {
  public readonly cluster: Cluster
  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    const { vpc, config } = props;

    const ampWorkspaceId = config.ampWorkspaceId;
    const monitoringAccountId = config.monitoringAccountId;
    const envName = config.deployEnvironment;
    const region = this.region;
    const account = this.account;

    const adotParam = `/rems/${envName}/adot-config`;
    const jmxParam = `/rems/${envName}/jmx-config`;

    const isProd = config.deployEnvironment === "prod" || config.deployEnvironment === "production";

    console.log("env:", config.deployEnvironment, "AMP:", config.ampWorkspaceId, "MON:", config.monitoringAccountId);

    const validAmp = !!config.ampWorkspaceId && /^ws-[0-9a-f-]+$/i.test(config.ampWorkspaceId);
    const validMonAcct = !!config.monitoringAccountId && /^[0-9]{12}$/.test(config.monitoringAccountId);

    if (isProd && (!validAmp || !validMonAcct)) {
      throw new Error("Prod requires valid ampWorkspaceId (ws-*) and monitoringAccountId (12 digits).");
    }

    this.cluster = new Cluster(this, "Cluster", { vpc, clusterName: "Rems" });

    const dbSecretName = ssm.StringParameter.fromStringParameterAttributes(
      this, "DbSecretName",
      { parameterName: `/rems/${config.deployEnvironment}/db-secret-name` }
    );

    const smtpSecretName = ssm.StringParameter.fromStringParameterAttributes(
      this, "SmtpSecretName",
      { parameterName: `/rems/${config.deployEnvironment}/smtp-secret-name` }
    );

    const webAclArn = ssm.StringParameter.fromStringParameterAttributes(
      this, "webAclArn",
      { parameterName: `/rems/${config.deployEnvironment}/webAclArn` }
    );

    const dbSecret = Secret.fromSecretNameV2(this, "DbSecret", dbSecretName.stringValue);
    const smtpSecret = Secret.fromSecretNameV2(this, "SmtpSecret", smtpSecretName.stringValue);

    const executionRole = new Role(this, "RemsExecutionRole", {
      assumedBy: new ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "Explicit execution role for REMS Fargate tasks",
      roleName: `${config.deployEnvironment}-rems-task-execution-role`,
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy"),
      ],
    });

    const privateKeySecret = Secret.fromSecretNameV2(this, "PrivateKey", "rems/visa/private-key.jwk");
    const publicKeySecret = Secret.fromSecretNameV2(this, "PublicKey", "rems/visa/public-key.jwk");

    const oidcSecret = Secret.fromSecretCompleteArn(this, "OidcSecret", config.oidcClientSecretArn);

    // ── NEW: webhook shared secret ──────────────────────────────────────────
    // Store the generated secret in Secrets Manager:
    //   aws secretsmanager create-secret \
    //     --name "rems/webhook-secret" \
    //     --secret-string "<generated>" \
    //     --region ap-southeast-2
    const webhookSecret = Secret.fromSecretCompleteArn(
      this, "RemsWebhookSecret", config.webhookSecretArn
    );
    // ───────────────────────────────────────────────────────────────────────

    executionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:rems/visa/*`,
        ],
      })
    );

    executionRole.addToPrincipalPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:rems-oidc-client-secret-??????`,
        ],
      })
    );

    // ── NEW: grant executionRole access to webhook secret ───────────────────
    executionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:rems/*`,
        ],
      })
    );
    // ───────────────────────────────────────────────────────────────────────

    executionRole.addToPrincipalPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
        ],
        resources: [`arn:aws:ecr:${this.region}:${this.account}:repository/rems`],
      })
    );

    executionRole.addToPrincipalPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["ecr:GetAuthorizationToken"],
        resources: ["*"],
      })
    );

    executionRole.addToPolicy(
      new PolicyStatement({
        actions: [
          "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel",
        ],
        resources: ["*"],
      })
    );

    const taskRole = new iam.Role(this, "RemsTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "ECS task runtime role for REMS app + ADOT collector",
      // Stable name so a cross-account AMP workspace resource policy can
      // allow-list this exact principal (e.g. "prod-bpsyc-rems-task-role").
      roleName: `${config.deployEnvironment}-${(config.project ?? "rems").toLowerCase()}-rems-task-role`,
    });

    const taskDef = new FargateTaskDefinition(this, "TaskDef", {
      cpu: 512,
      memoryLimitMiB: 1024,
      taskRole,
      executionRole,
    });

    const logGroup = new LogGroup(this, "RemsLogGroup", {
      logGroupName: `/${config.project}/rems/${config.deployEnvironment}`,
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    const container = taskDef.addContainer("RemsContainer", {
      image: ContainerImage.fromRegistry(config.containerImage),
      environment: {
        DB_NAME: config.dbName,
        DB_USER: config.dbUser,
        PUBLIC_URL: config.publicUrl,
        CMD: "start",
        REQUESTOR_URL: config.requestorUrl,
        // ───────────────────────────────────────────────────────────────────
      },
      secrets: {
        DB_PASSWORD: ECSSecret.fromSecretsManager(dbSecret!, "password"),
        DB_HOST: ECSSecret.fromSecretsManager(dbSecret!, "host"),
        DB_PORT: ECSSecret.fromSecretsManager(dbSecret!, "port"),
        SMTP_HOST: ECSSecret.fromSecretsManager(smtpSecret!, "host"),
        SMTP_PORT: ECSSecret.fromSecretsManager(smtpSecret!, "port"),
        SMTP_USER: ECSSecret.fromSecretsManager(smtpSecret!, "username"),
        SMTP_PASSWORD: ECSSecret.fromSecretsManager(smtpSecret!, "password"),
        SMTP_SENDER: ECSSecret.fromSecretsManager(smtpSecret!, "sender"),
        OIDC_METADATA_URL: ECSSecret.fromSecretsManager(oidcSecret, "oidc-metadata-url"),
        OIDC_CLIENT_ID: ECSSecret.fromSecretsManager(oidcSecret, "oidc-client-id"),
        OIDC_CLIENT_SECRET: ECSSecret.fromSecretsManager(oidcSecret, "oidc-client-secret"),
        REMS_WEBHOOK_SECRET: ECSSecret.fromSecretsManager(webhookSecret),
        // ───────────────────────────────────────────────────────────────────
      },
      portMappings: [{ containerPort: 3000 }],
      logging: LogDriver.awsLogs({
        streamPrefix: "Rems",
        logGroup,
        mode: AwsLogDriverMode.NON_BLOCKING,
      }),
    });

    const configVolumeName = "adot-config-vol";

    if (isProd) {
      taskRole.addToPolicy(new iam.PolicyStatement({
        actions: ["aps:RemoteWrite"],
        resources: [
          `arn:aws:aps:${region}:${monitoringAccountId}:workspace/${ampWorkspaceId}`,
        ],
      }));
      taskRole.addToPolicy(new iam.PolicyStatement({
        actions: ["ssm:GetParameters", "ssm:GetParameter", "ssm:GetParametersByPath"],
        resources: [
          `arn:aws:ssm:${region}:${account}:parameter${adotParam}`,
          `arn:aws:ssm:${region}:${account}:parameter${jmxParam}`,
        ],
      }));

      taskDef.addVolume({ name: configVolumeName });

      // Hardening: source the JMX agent from an overridable URL (point this at an
      // in-account S3/ECR mirror in production) and optionally verify a checksum.
      const jmxAgentUrl =
        config.jmxAgentUrl ??
        "https://repo1.maven.org/maven2/io/prometheus/jmx/jmx_prometheus_javaagent/0.20.0/jmx_prometheus_javaagent-0.20.0.jar";
      const jmxAgentSha256 = config.jmxAgentSha256;

      const adotConfigParam = ssm.StringParameter.fromStringParameterAttributes(this, "AdotConfigParam", {
        parameterName: adotParam,
      });

      const configLoader = taskDef.addContainer("adot-config-loader", {
        image: ContainerImage.fromRegistry("amazon/aws-cli:2.15.47"),
        essential: false,
        entryPoint: ["/bin/sh", "-lc"],
        command: [
          [
            `set -euo pipefail`,
            `mkdir -p /config /opt/jmx`,
            `aws ssm get-parameter --name ${jmxParam}  --with-decryption --query Parameter.Value --output text > /config/jmx.yaml`,
            `curl -fsSL -o /opt/jmx/jmx_prometheus_javaagent.jar "${jmxAgentUrl}" || wget -qO /opt/jmx/jmx_prometheus_javaagent.jar "${jmxAgentUrl}"`,
            `[ -s /opt/jmx/jmx_prometheus_javaagent.jar ]`,
            ...(jmxAgentSha256
              ? [`echo "${jmxAgentSha256}  /opt/jmx/jmx_prometheus_javaagent.jar" | sha256sum -c -`]
              : []),
            `echo "JMX config loaded to /config/jmx.yaml"`,
            `echo "JMX agent downloaded to /opt/jmx/jmx_prometheus_javaagent.jar"`,
            "ls -l /config",
            "ls -l /opt/jmx",
          ].join(" && "),
        ],
        environment: { "AWS_REGION": region },
        logging: LogDriver.awsLogs({ streamPrefix: "adot-config-loader" }),
      });

      configLoader.addMountPoints({ containerPath: "/config", readOnly: false, sourceVolume: configVolumeName });
      configLoader.addMountPoints({ containerPath: "/opt/jmx", readOnly: false, sourceVolume: configVolumeName });

      const adotImage =
        config.adotCollectorImage ??
        "public.ecr.aws/aws-observability/aws-otel-collector:v0.43.2"; // pin; prefer a digest you've verified

      const adot = taskDef.addContainer("aws-otel-collector", {
        image: ContainerImage.fromRegistry(adotImage),
        essential: true,
        environment: {
          AWS_REGION: region,
          AMP_WORKSPACE_ID: ampWorkspaceId,      // was missing — remote_write endpoint needs it
          REMS_INSTANCE: config.project ?? "rems",
          REMS_ENV: envName,
        },
        secrets: {
          AOT_CONFIG_CONTENT: ECSSecret.fromSsmParameter(adotConfigParam)
        },
        logging: LogDriver.awsLogs({ streamPrefix: "adot" }),
      });

      adot.addMountPoints({ containerPath: "/config", readOnly: true, sourceVolume: configVolumeName });
      adot.addContainerDependencies({ container: configLoader, condition: ContainerDependencyCondition.SUCCESS });

      container.addMountPoints(
        { containerPath: "/opt/jmx", sourceVolume: configVolumeName, readOnly: true },
        { containerPath: "/config", readOnly: true, sourceVolume: configVolumeName }
      );
      container.addEnvironment("JAVA_TOOL_OPTIONS",
        "-javaagent:/opt/jmx/jmx_prometheus_javaagent.jar=9404:/config/jmx.yaml"
      );
      container.addContainerDependencies({
        container: configLoader,
        condition: ContainerDependencyCondition.SUCCESS,
      });
    }

    container.addSecret("PRIVATE_KEY", ECSSecret.fromSecretsManager(privateKeySecret));
    container.addSecret("PUBLIC_KEY", ECSSecret.fromSecretsManager(publicKeySecret));

    const fargateSG = new SecurityGroup(this, "FargateSG", {
      vpc,
      allowAllOutbound: true,
      description: "Security group for REMS Fargate service",
    });

    const service = new FargateService(this, "Service", {
      cluster: this.cluster,
      taskDefinition: taskDef,
      securityGroups: [fargateSG],
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      propagateTags: PropagatedTagSource.SERVICE,
      enableECSManagedTags: true,
      healthCheckGracePeriod: Duration.seconds(120),
      enableExecuteCommand: true,
    });

    const lb = new ApplicationLoadBalancer(this, "LB", { vpc, internetFacing: true });

    const cert = Certificate.fromCertificateArn(this, "Cert", config.certificateArn);

    const listener = lb.addListener("HttpsListener", {
      port: 443,
      certificates: [cert],
    });

    listener.addTargets("ECS", {
      port: 3000,
      protocol: ApplicationProtocol.HTTP,
      protocolVersion: ApplicationProtocolVersion.HTTP1,
      targets: [service],
      healthCheck: {
        path: "/",
        interval: Duration.seconds(30),
        timeout: Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5,
      },
    });

    fargateSG.addIngressRule(
      lb.connections.securityGroups[0],
      Port.tcp(3000),
      "Allow ALB to access REMS container"
    );

    new wafv2.CfnWebACLAssociation(this, "WafAssociation", {
      resourceArn: lb.loadBalancerArn,
      webAclArn: webAclArn.stringValue,
    });

    // DNS is optional. Default: CDK creates the ALB alias record. Set
    // manageDnsRecord=false to skip the hosted-zone lookup and the record
    // entirely and manage DNS by hand (e.g. centralised/cross-account DNS) —
    // point your own record at the ALB output below. When managing, an explicit
    // hostedZoneId avoids the name-based lookup (deterministic, no synth-time
    // context/credentials needed).
    const manageDns = config.manageDnsRecord ?? true;
    if (manageDns) {
      const zone = config.hostedZoneId
        ? route53.HostedZone.fromHostedZoneAttributes(this, "HostedZone", {
            hostedZoneId: config.hostedZoneId,
            zoneName: config.hostZone,
          })
        : route53.HostedZone.fromLookup(this, "HostedZone", {
            domainName: config.hostZone,
          });

      new route53.ARecord(this, "RemsAliasRecord", {
        zone,
        target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(lb)),
        recordName: config.hostName,
      });
    }

    // Always surface the ALB DNS so DNS can be pointed at it manually when
    // manageDnsRecord is false (and for convenience otherwise).
    new CfnOutput(this, "LoadBalancerDnsName", {
      value: lb.loadBalancerDnsName,
      description: `Point ${config.hostName} at this ALB (CNAME/ALIAS) if managing DNS manually`,
    });
  }
}