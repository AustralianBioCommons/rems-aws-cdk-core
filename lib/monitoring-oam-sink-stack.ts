import { Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as oam from "aws-cdk-lib/aws-oam";

interface OamLinkProps extends StackProps {
  /** OAM sink ARN in the central monitoring account. */
  sinkIdentifier: string;
  /** Used to label the link, e.g. "prod-bpsyc-REMS". */
  project: string;
  deployEnvironment: string;
}

/**
 * Deployed in the WORKLOAD account. Creates an OAM *link* to the central
 * monitoring account's sink, sharing this project's CloudWatch metrics/logs/
 * traces. (The sink itself is a central-account resource.)
 */
export class MonitoringOamSinkStack extends Stack {
  constructor(scope: Construct, id: string, props: OamLinkProps) {
    super(scope, id, props);

    new oam.CfnLink(this, "WorkloadToMonitoringLink", {
      sinkIdentifier: props.sinkIdentifier,
      labelTemplate: `${props.deployEnvironment}-${props.project}-REMS`,
      resourceTypes: [
        "AWS::CloudWatch::Metric",
        "AWS::Logs::LogGroup",
        "AWS::XRay::Trace",
      ],
    });
  }
}
