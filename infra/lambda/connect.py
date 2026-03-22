import json
import os
import time

import boto3

connections_table = boto3.resource('dynamodb').Table(os.environ['CONNECTIONS_TABLE'])
CONNECTION_TTL_SECONDS = int(os.environ.get('CONNECTION_TTL_SECONDS', '86400'))


def handler(event, _context):
    connection_id = event['requestContext']['connectionId']

    now = int(time.time())
    connections_table.put_item(
        Item={
            'connectionId': connection_id,
            'roomId': '__unjoined__',
            'joinedAt': now,
            'ttl': now + CONNECTION_TTL_SECONDS,
        }
    )

    return {
        'statusCode': 200,
        'body': json.dumps({'ok': True}),
    }
