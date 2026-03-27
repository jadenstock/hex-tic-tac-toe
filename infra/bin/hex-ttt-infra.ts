#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib'
import { HexTttCertificateStack } from '../lib/hex-ttt-certificate-stack'
import { HexTttStack } from '../lib/hex-ttt-stack'

const app = new cdk.App()

const account = process.env.CDK_DEFAULT_ACCOUNT
const region = process.env.CDK_DEFAULT_REGION

const domainName = app.node.tryGetContext('domainName') as string | undefined
const hostedZoneDomain = app.node.tryGetContext('hostedZoneDomain') as string | undefined
const certificateArn = app.node.tryGetContext('certificateArn') as string | undefined
const includeWwwContext = app.node.tryGetContext('includeWww')
const includeWww =
  includeWwwContext === undefined
    ? true
    : typeof includeWwwContext === 'boolean'
      ? includeWwwContext
      : String(includeWwwContext).toLowerCase() === 'true'

if ((domainName && !certificateArn) || (!domainName && certificateArn)) {
  throw new Error(
    'Invalid custom-domain context: domainName and certificateArn must be provided together (or both omitted).',
  )
}

if (domainName) {
  new HexTttCertificateStack(app, 'HexTttCertificateStack', {
    env: {
      account,
      region: 'us-east-1',
    },
    domainName,
    hostedZoneDomain,
    includeWww,
  })
}

new HexTttStack(app, 'HexTttStack', {
  env: {
    account,
    region,
  },
  customDomain:
    domainName && certificateArn
      ? {
          domainName,
          hostedZoneDomain,
          includeWww,
          certificateArn,
        }
      : undefined,
})
