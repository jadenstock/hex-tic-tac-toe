import * as path from 'node:path'
import { CfnOutput, Duration, Fn, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as targets from 'aws-cdk-lib/aws-route53-targets'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment'
import { Construct } from 'constructs'

export interface HexTttStackProps extends StackProps {
  customDomain?: {
    domainName: string
    hostedZoneDomain?: string
    includeWww?: boolean
    certificateArn: string
  }
}

export class HexTttStack extends Stack {
  constructor(scope: Construct, id: string, props?: HexTttStackProps) {
    super(scope, id, props)

    const roomsTable = new dynamodb.Table(this, 'RoomsTable', {
      partitionKey: {
        name: 'roomId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'expiresAt',
    })

    const connectionsTable = new dynamodb.Table(this, 'ConnectionsTable', {
      partitionKey: {
        name: 'connectionId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    })

    connectionsTable.addGlobalSecondaryIndex({
      indexName: 'roomId-index',
      partitionKey: {
        name: 'roomId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'connectionId',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    })

    const lambdaCode = lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda'))

    const lambdaEnv = {
      ROOMS_TABLE: roomsTable.tableName,
      CONNECTIONS_TABLE: connectionsTable.tableName,
      CONNECTIONS_ROOM_INDEX: 'roomId-index',
      CONNECTION_TTL_SECONDS: String(Duration.days(1).toSeconds()),
      ROOM_TTL_SECONDS: String(Duration.days(7).toSeconds()),
    }

    const connectFn = new lambda.Function(this, 'WsConnectFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambdaCode,
      handler: 'connect.handler',
      environment: lambdaEnv,
      timeout: Duration.seconds(10),
    })

    const disconnectFn = new lambda.Function(this, 'WsDisconnectFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambdaCode,
      handler: 'disconnect.handler',
      environment: lambdaEnv,
      timeout: Duration.seconds(10),
    })

    const messageFn = new lambda.Function(this, 'WsMessageFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambdaCode,
      handler: 'message.handler',
      environment: lambdaEnv,
      timeout: Duration.seconds(20),
    })

    roomsTable.grantReadWriteData(messageFn)
    roomsTable.grantReadWriteData(disconnectFn)
    connectionsTable.grantReadWriteData(connectFn)
    connectionsTable.grantReadWriteData(disconnectFn)
    connectionsTable.grantReadWriteData(messageFn)

    const wsApi = new apigwv2.CfnApi(this, 'WsApi', {
      name: 'hex-ttt-ws',
      protocolType: 'WEBSOCKET',
      routeSelectionExpression: '$request.body.action',
    })

    const toIntegrationUri = (fn: lambda.Function): string => {
      return `arn:aws:apigateway:${this.region}:lambda:path/2015-03-31/functions/${fn.functionArn}/invocations`
    }

    const connectIntegration = new apigwv2.CfnIntegration(this, 'ConnectIntegration', {
      apiId: wsApi.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: toIntegrationUri(connectFn),
    })

    const disconnectIntegration = new apigwv2.CfnIntegration(this, 'DisconnectIntegration', {
      apiId: wsApi.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: toIntegrationUri(disconnectFn),
    })

    const messageIntegration = new apigwv2.CfnIntegration(this, 'MessageIntegration', {
      apiId: wsApi.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: toIntegrationUri(messageFn),
    })

    const connectRoute = new apigwv2.CfnRoute(this, 'ConnectRoute', {
      apiId: wsApi.ref,
      routeKey: '$connect',
      authorizationType: 'NONE',
      target: `integrations/${connectIntegration.ref}`,
    })

    const disconnectRoute = new apigwv2.CfnRoute(this, 'DisconnectRoute', {
      apiId: wsApi.ref,
      routeKey: '$disconnect',
      authorizationType: 'NONE',
      target: `integrations/${disconnectIntegration.ref}`,
    })

    const joinRoute = new apigwv2.CfnRoute(this, 'JoinRoute', {
      apiId: wsApi.ref,
      routeKey: 'join',
      authorizationType: 'NONE',
      target: `integrations/${messageIntegration.ref}`,
    })

    const createRoute = new apigwv2.CfnRoute(this, 'CreateRoute', {
      apiId: wsApi.ref,
      routeKey: 'create',
      authorizationType: 'NONE',
      target: `integrations/${messageIntegration.ref}`,
    })

    const placeRoute = new apigwv2.CfnRoute(this, 'PlaceRoute', {
      apiId: wsApi.ref,
      routeKey: 'place',
      authorizationType: 'NONE',
      target: `integrations/${messageIntegration.ref}`,
    })

    const undoRoute = new apigwv2.CfnRoute(this, 'UndoRoute', {
      apiId: wsApi.ref,
      routeKey: 'undo',
      authorizationType: 'NONE',
      target: `integrations/${messageIntegration.ref}`,
    })

    const syncRoute = new apigwv2.CfnRoute(this, 'SyncRoute', {
      apiId: wsApi.ref,
      routeKey: 'sync',
      authorizationType: 'NONE',
      target: `integrations/${messageIntegration.ref}`,
    })

    const defaultRoute = new apigwv2.CfnRoute(this, 'DefaultRoute', {
      apiId: wsApi.ref,
      routeKey: '$default',
      authorizationType: 'NONE',
      target: `integrations/${messageIntegration.ref}`,
    })

    const deployment = new apigwv2.CfnDeployment(this, 'WsDeployment', {
      apiId: wsApi.ref,
    })
    deployment.node.addDependency(connectRoute)
    deployment.node.addDependency(disconnectRoute)
    deployment.node.addDependency(joinRoute)
    deployment.node.addDependency(createRoute)
    deployment.node.addDependency(placeRoute)
    deployment.node.addDependency(undoRoute)
    deployment.node.addDependency(syncRoute)
    deployment.node.addDependency(defaultRoute)

    const stage = new apigwv2.CfnStage(this, 'WsProdStage', {
      apiId: wsApi.ref,
      stageName: 'prod',
      deploymentId: deployment.ref,
      autoDeploy: true,
    })

    const sourceArnBase = `arn:aws:execute-api:${this.region}:${this.account}:${wsApi.ref}`
    const manageConnectionsArn = `${sourceArnBase}/*/POST/@connections/*`

    messageFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['execute-api:ManageConnections'],
        resources: [manageConnectionsArn],
      }),
    )

    connectFn.addPermission('AllowInvokeConnect', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: `${sourceArnBase}/*/$connect`,
    })

    disconnectFn.addPermission('AllowInvokeDisconnect', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: `${sourceArnBase}/*/$disconnect`,
    })

    messageFn.addPermission('AllowInvokeMessage', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: `${sourceArnBase}/*/*`,
    })

    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    })

    const archiveBucket = new s3.Bucket(this, 'ArchiveBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      versioned: true,
    })

    const trackedGamesFn = new lambda.Function(this, 'TrackedGamesFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambdaCode,
      handler: 'tracked_games.handler',
      environment: {
        ...lambdaEnv,
        ARCHIVE_BUCKET: archiveBucket.bucketName,
      },
      timeout: Duration.seconds(20),
    })

    messageFn.addEnvironment('ARCHIVE_BUCKET', archiveBucket.bucketName)
    archiveBucket.grantReadWrite(messageFn)
    archiveBucket.grantReadWrite(trackedGamesFn)

    const trackedGamesApi = new apigwv2.CfnApi(this, 'TrackedGamesApi', {
      name: 'hex-ttt-games',
      protocolType: 'HTTP',
    })

    const trackedGamesIntegration = new apigwv2.CfnIntegration(this, 'TrackedGamesIntegration', {
      apiId: trackedGamesApi.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: toIntegrationUri(trackedGamesFn),
      payloadFormatVersion: '2.0',
    })

    const trackedGamesGetRoute = new apigwv2.CfnRoute(this, 'TrackedGamesGetRoute', {
      apiId: trackedGamesApi.ref,
      routeKey: 'GET /games/{gameId}',
      target: `integrations/${trackedGamesIntegration.ref}`,
    })

    const trackedGamesGetApiPrefixedRoute = new apigwv2.CfnRoute(this, 'TrackedGamesGetApiPrefixedRoute', {
      apiId: trackedGamesApi.ref,
      routeKey: 'GET /api/games/{gameId}',
      target: `integrations/${trackedGamesIntegration.ref}`,
    })

    const trackedGamesPostRoute = new apigwv2.CfnRoute(this, 'TrackedGamesPostRoute', {
      apiId: trackedGamesApi.ref,
      routeKey: 'POST /games',
      target: `integrations/${trackedGamesIntegration.ref}`,
    })

    const trackedGamesPostApiPrefixedRoute = new apigwv2.CfnRoute(this, 'TrackedGamesPostApiPrefixedRoute', {
      apiId: trackedGamesApi.ref,
      routeKey: 'POST /api/games',
      target: `integrations/${trackedGamesIntegration.ref}`,
    })

    const trackedGamesStage = new apigwv2.CfnStage(this, 'TrackedGamesStage', {
      apiId: trackedGamesApi.ref,
      stageName: '$default',
      autoDeploy: true,
    })
    trackedGamesStage.node.addDependency(trackedGamesGetRoute)
    trackedGamesStage.node.addDependency(trackedGamesGetApiPrefixedRoute)
    trackedGamesStage.node.addDependency(trackedGamesPostRoute)
    trackedGamesStage.node.addDependency(trackedGamesPostApiPrefixedRoute)

    const trackedGamesSourceArn = `arn:aws:execute-api:${this.region}:${this.account}:${trackedGamesApi.ref}/*/*`
    trackedGamesFn.addPermission('AllowInvokeTrackedGames', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: trackedGamesSourceArn,
    })

    const trackedGamesApiDomain = Fn.select(2, Fn.split('/', trackedGamesApi.attrApiEndpoint))

    const customDomain = props?.customDomain
    const distributionProps: cloudfront.DistributionProps = {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: {
        'api/*': {
          origin: new origins.HttpOrigin(trackedGamesApiDomain, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
      ],
      ...(customDomain
        ? {
            domainNames: [
              customDomain.domainName,
              ...(customDomain.includeWww === false ? [] : [`www.${customDomain.domainName}`]),
            ],
            certificate: acm.Certificate.fromCertificateArn(
              this,
              'SiteCustomDomainCert',
              customDomain.certificateArn,
            ),
          }
        : {}),
    }

    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', distributionProps)

    new s3deploy.BucketDeployment(this, 'DeployFrontend', {
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', '..', 'dist'))],
      retainOnDelete: false,
    })

    new CfnOutput(this, 'SiteUrl', {
      value: `https://${distribution.domainName}`,
    })

    if (props?.customDomain) {
      const hostedZone = route53.HostedZone.fromLookup(this, 'CustomDomainHostedZone', {
        domainName: props.customDomain.hostedZoneDomain ?? props.customDomain.domainName,
      })
      const aliasTarget = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution))

      new route53.ARecord(this, 'ApexAliasA', {
        zone: hostedZone,
        recordName: props.customDomain.domainName,
        target: aliasTarget,
      })
      new route53.AaaaRecord(this, 'ApexAliasAAAA', {
        zone: hostedZone,
        recordName: props.customDomain.domainName,
        target: aliasTarget,
      })

      if (props.customDomain.includeWww !== false) {
        new route53.ARecord(this, 'WwwAliasA', {
          zone: hostedZone,
          recordName: `www.${props.customDomain.domainName}`,
          target: aliasTarget,
        })
        new route53.AaaaRecord(this, 'WwwAliasAAAA', {
          zone: hostedZone,
          recordName: `www.${props.customDomain.domainName}`,
          target: aliasTarget,
        })
      }

      new CfnOutput(this, 'CustomDomainUrl', {
        value: `https://${props.customDomain.domainName}`,
      })
    }

    new CfnOutput(this, 'WebSocketUrl', {
      value: `wss://${wsApi.ref}.execute-api.${this.region}.${this.urlSuffix}/${stage.stageName}`,
    })

    new CfnOutput(this, 'RoomsTableName', {
      value: roomsTable.tableName,
    })

    new CfnOutput(this, 'ConnectionsTableName', {
      value: connectionsTable.tableName,
    })

    new CfnOutput(this, 'ArchiveBucketName', {
      value: archiveBucket.bucketName,
    })

    new CfnOutput(this, 'TrackedGamesApiUrl', {
      value: trackedGamesApi.attrApiEndpoint,
    })
  }
}
