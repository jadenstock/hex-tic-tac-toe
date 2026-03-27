import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as route53 from 'aws-cdk-lib/aws-route53'
import { Construct } from 'constructs'

export interface HexTttCertificateStackProps extends StackProps {
  domainName: string
  hostedZoneDomain?: string
  includeWww?: boolean
}

export class HexTttCertificateStack extends Stack {
  public readonly certificate: acm.Certificate

  constructor(scope: Construct, id: string, props: HexTttCertificateStackProps) {
    super(scope, id, props)

    const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
      domainName: props.hostedZoneDomain ?? props.domainName,
    })

    this.certificate = new acm.Certificate(this, 'SiteCertificate', {
      domainName: props.domainName,
      subjectAlternativeNames: props.includeWww === false ? [] : [`www.${props.domainName}`],
      validation: acm.CertificateValidation.fromDns(hostedZone),
    })

    new CfnOutput(this, 'CertificateArn', {
      value: this.certificate.certificateArn,
    })
  }
}
