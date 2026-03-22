import json
import os

import boto3

connections_table = boto3.resource('dynamodb').Table(os.environ['CONNECTIONS_TABLE'])


def handler(event, _context):
    connection_id = event['requestContext']['connectionId']
    connections_table.delete_item(Key={'connectionId': connection_id})

    return {
        'statusCode': 200,
        'body': json.dumps({'ok': True}),
    }
