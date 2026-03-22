#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib'
import { HexTttStack } from '../lib/hex-ttt-stack'

const app = new cdk.App()

new HexTttStack(app, 'HexTttStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
})
