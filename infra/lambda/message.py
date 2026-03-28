import json
import os
import secrets
import string
import time
from typing import Any, Dict

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from archive_store import normalize_move_history, normalize_participants, new_game_id, write_archive

rooms_table = boto3.resource('dynamodb').Table(os.environ['ROOMS_TABLE'])
connections_table = boto3.resource('dynamodb').Table(os.environ['CONNECTIONS_TABLE'])
connections_room_index = os.environ['CONNECTIONS_ROOM_INDEX']
CONNECTION_TTL_SECONDS = int(os.environ.get('CONNECTION_TTL_SECONDS', '86400'))
ROOM_TTL_SECONDS = int(os.environ.get('ROOM_TTL_SECONDS', '604800'))
GAME_CODE_CHARS = string.ascii_uppercase + string.digits
GAME_CODE_LEN = 5
WIN_LENGTH = 6
WIN_DIRECTIONS = (
    (1, 0),
    (0, 1),
    (1, -1),
)


def _response(status_code: int, payload: Dict[str, Any]) -> Dict[str, Any]:
    return {
        'statusCode': status_code,
        'body': json.dumps(payload),
    }


def _parse_body(event: Dict[str, Any]) -> Dict[str, Any]:
    body = event.get('body') or '{}'
    if isinstance(body, str):
        return json.loads(body)
    if isinstance(body, dict):
        return body
    return {}


def _ws_client(event: Dict[str, Any]):
    domain_name = event['requestContext']['domainName']
    stage = event['requestContext']['stage']
    endpoint = f"https://{domain_name}/{stage}"
    return boto3.client('apigatewaymanagementapi', endpoint_url=endpoint)


def _post_to_connection(client, connection_id: str, payload: Dict[str, Any]) -> bool:
    try:
        client.post_to_connection(
            ConnectionId=connection_id,
            Data=json.dumps(payload).encode('utf-8'),
        )
        return True
    except ClientError as exc:
        if exc.response.get('Error', {}).get('Code') == 'GoneException':
            connections_table.delete_item(Key={'connectionId': connection_id})
            return False
        raise


def _load_room(room_id: str):
    room_resp = rooms_table.get_item(Key={'roomId': room_id})
    return room_resp.get('Item')


def _build_board_from_history(move_history: list[Dict[str, Any]]) -> Dict[str, str]:
    board: Dict[str, str] = {}
    for move in move_history:
        board[f"{move['q']},{move['r']}"] = move['mark']
    return board


def _count_direction(board: Dict[str, str], q: int, r: int, dq: int, dr: int, player: str) -> int:
    count = 0
    cq = q + dq
    cr = r + dr
    while board.get(f'{cq},{cr}') == player:
        count += 1
        cq += dq
        cr += dr
    return count


def _find_winner(board: Dict[str, str]) -> str | None:
    for key, player in board.items():
        if player not in ('X', 'O'):
            continue
        q_str, r_str = key.split(',')
        q = int(q_str)
        r = int(r_str)
        for dq, dr in WIN_DIRECTIONS:
            forward = _count_direction(board, q, r, dq, dr, player)
            backward = _count_direction(board, q, r, -dq, -dr, player)
            if 1 + forward + backward >= WIN_LENGTH:
                return player
    return None


def _save_room(room: Dict[str, Any]):
    now = int(time.time())
    expires_at = now + ROOM_TTL_SECONDS
    room['updatedAt'] = now
    room['expiresAt'] = expires_at
    room['archiveKey'] = f"games/{room['gameId']}.json"
    rooms_table.put_item(Item=room)
    write_archive(room)


def _room_snapshot_payload(room: Dict[str, Any], msg_type: str = 'state_snapshot', created: bool = False) -> Dict[str, Any]:
    payload = {
        'type': msg_type,
        'roomId': room['roomId'],
        'gameId': room.get('gameId'),
        'boardState': room.get('boardState', {}),
        'moveHistory': normalize_move_history(room.get('moveHistory', [])),
        'participants': normalize_participants(room.get('participants')),
        'status': room.get('status'),
        'winner': room.get('winner'),
        'resultType': room.get('resultType'),
    }
    if created:
        payload['created'] = True
    return payload


def _broadcast_room(client, room_id: str, payload: Dict[str, Any]):
    response = connections_table.query(
        IndexName=connections_room_index,
        KeyConditionExpression=Key('roomId').eq(room_id),
    )

    for item in response.get('Items', []):
        connection_id = item.get('connectionId')
        if connection_id:
            _post_to_connection(client, connection_id, payload)


def _upsert_connection_room(connection_id: str, room_id: str):
    now = int(time.time())
    connections_table.update_item(
        Key={'connectionId': connection_id},
        UpdateExpression='SET roomId = :roomId, joinedAt = :joinedAt, #ttl = :ttl',
        ExpressionAttributeNames={
            '#ttl': 'ttl',
        },
        ExpressionAttributeValues={
            ':roomId': room_id,
            ':joinedAt': now,
            ':ttl': now + CONNECTION_TTL_SECONDS,
        },
    )


def _send_error(client, connection_id: str, message: str):
    _post_to_connection(
        client,
        connection_id,
        {
            'type': 'error',
            'message': message,
        },
    )


def _new_game_code() -> str:
    return ''.join(secrets.choice(GAME_CODE_CHARS) for _ in range(GAME_CODE_LEN))


def _create_room(participants: Dict[str, Any], game_mode: str) -> Dict[str, Any] | None:
    now = int(time.time())
    expires_at = now + ROOM_TTL_SECONDS

    for _ in range(20):
        room_id = _new_game_code()
        room = {
            'roomId': room_id,
            'gameId': new_game_id(),
            'boardState': {},
            'moveHistory': [],
            'participants': normalize_participants(participants),
            'status': 'pending',
            'resultType': None,
            'winner': None,
            'gameMode': game_mode or 'live',
            'createdAt': now,
            'updatedAt': now,
            'expiresAt': expires_at,
        }
        room['archiveKey'] = f"games/{room['gameId']}.json"
        try:
            rooms_table.put_item(
                Item=room,
                ConditionExpression='attribute_not_exists(roomId)',
            )
            write_archive(room)
            return room
        except ClientError as exc:
            if exc.response.get('Error', {}).get('Code') != 'ConditionalCheckFailedException':
                raise

    return None


def _handle_create(event: Dict[str, Any]) -> Dict[str, Any]:
    connection_id = event['requestContext']['connectionId']
    body = _parse_body(event)
    client = _ws_client(event)

    room = _create_room(body.get('participants', {}), str(body.get('gameMode') or 'live'))
    if not room:
        _send_error(client, connection_id, 'failed to create game code')
        return _response(500, {'ok': False})

    _upsert_connection_room(connection_id, room['roomId'])

    _post_to_connection(
        client,
        connection_id,
        _room_snapshot_payload(room, created=True),
    )

    return _response(200, {'ok': True})


def _handle_join(event: Dict[str, Any]) -> Dict[str, Any]:
    connection_id = event['requestContext']['connectionId']
    body = _parse_body(event)
    client = _ws_client(event)

    room_id = str(body.get('roomId', '')).strip().upper()

    if not room_id or len(room_id) > GAME_CODE_LEN or not room_id.isalnum():
        _send_error(client, connection_id, 'game code must be 1-5 letters/numbers')
        return _response(400, {'ok': False})

    room = _load_room(room_id)
    if room is None:
        _send_error(client, connection_id, 'game not found')
        return _response(404, {'ok': False})

    _upsert_connection_room(connection_id, room_id)
    _save_room(room)

    _post_to_connection(client, connection_id, _room_snapshot_payload(room))

    return _response(200, {'ok': True})


def _handle_place(event: Dict[str, Any]) -> Dict[str, Any]:
    connection_id = event['requestContext']['connectionId']
    body = _parse_body(event)
    client = _ws_client(event)

    connection_item = connections_table.get_item(Key={'connectionId': connection_id}).get('Item')
    if not connection_item:
        _send_error(client, connection_id, 'connection not found')
        return _response(403, {'ok': False})

    room_id = connection_item.get('roomId')
    if not room_id or room_id == '__unjoined__':
        _send_error(client, connection_id, 'join a game before placing')
        return _response(403, {'ok': False})

    mark = str(body.get('mark', '')).upper()
    if mark not in ('X', 'O'):
        _send_error(client, connection_id, 'mark must be X or O')
        return _response(400, {'ok': False})

    try:
        q = int(body.get('q'))
        r = int(body.get('r'))
    except (TypeError, ValueError):
        _send_error(client, connection_id, 'q and r must be integers')
        return _response(400, {'ok': False})

    room = _load_room(room_id)
    if room is None:
        _send_error(client, connection_id, 'game not found')
        return _response(404, {'ok': False})

    move_history = normalize_move_history(room.get('moveHistory', []))
    board_state = dict(room.get('boardState', {}))
    winner = _find_winner(board_state)
    if winner:
        _send_error(client, connection_id, f'game already complete ({winner} won)')
        return _response(409, {'ok': False})

    if f'{q},{r}' in board_state:
        _send_error(client, connection_id, 'cell already occupied')
        return _response(409, {'ok': False})

    participants = normalize_participants(room.get('participants'))
    actor_type = participants.get(mark, {}).get('type')
    board_state[f'{q},{r}'] = mark
    move_history.append({'q': q, 'r': r, 'mark': mark, 'actorType': actor_type})

    room['boardState'] = board_state
    room['moveHistory'] = move_history
    room['winner'] = _find_winner(board_state)
    room['status'] = 'completed' if room['winner'] else 'active'
    room['resultType'] = 'win' if room['winner'] else None
    room.setdefault('startedAt', int(time.time()))
    if room['winner']:
        room['endedAt'] = int(time.time())
    else:
        room.pop('endedAt', None)
    _save_room(room)

    payload = _room_snapshot_payload(room, msg_type='move_applied')
    payload['move'] = {
        'q': q,
        'r': r,
        'mark': mark,
        'actorType': actor_type,
    }
    _broadcast_room(client, room_id, payload)

    return _response(200, {'ok': True})


def _handle_sync(event: Dict[str, Any]) -> Dict[str, Any]:
    connection_id = event['requestContext']['connectionId']
    client = _ws_client(event)

    connection_item = connections_table.get_item(Key={'connectionId': connection_id}).get('Item')
    if not connection_item:
        _send_error(client, connection_id, 'connection not found')
        return _response(403, {'ok': False})

    room_id = connection_item.get('roomId')
    if not room_id or room_id == '__unjoined__':
        _send_error(client, connection_id, 'join a game first')
        return _response(403, {'ok': False})

    room = _load_room(room_id)
    if room is None:
        _send_error(client, connection_id, 'game not found')
        return _response(404, {'ok': False})

    _save_room(room)

    _post_to_connection(client, connection_id, _room_snapshot_payload(room))

    return _response(200, {'ok': True})


def _handle_undo(event: Dict[str, Any]) -> Dict[str, Any]:
    connection_id = event['requestContext']['connectionId']
    client = _ws_client(event)

    connection_item = connections_table.get_item(Key={'connectionId': connection_id}).get('Item')
    if not connection_item:
        _send_error(client, connection_id, 'connection not found')
        return _response(403, {'ok': False})

    room_id = connection_item.get('roomId')
    if not room_id or room_id == '__unjoined__':
        _send_error(client, connection_id, 'join a game before undo')
        return _response(403, {'ok': False})

    room = _load_room(room_id)
    if room is None:
        _send_error(client, connection_id, 'game not found')
        return _response(404, {'ok': False})

    move_history = normalize_move_history(room.get('moveHistory', []))
    if not move_history:
        _send_error(client, connection_id, 'no moves to undo')
        return _response(400, {'ok': False})

    move_history.pop()
    board_state = _build_board_from_history(move_history)
    room['boardState'] = board_state
    room['moveHistory'] = move_history
    room['winner'] = _find_winner(board_state)
    room['status'] = 'completed' if room['winner'] else ('active' if move_history else 'pending')
    room['resultType'] = 'win' if room['winner'] else None
    if move_history:
        room.setdefault('startedAt', room.get('createdAt', int(time.time())))
    else:
        room.pop('startedAt', None)
    if room['winner']:
        room['endedAt'] = int(time.time())
    else:
        room.pop('endedAt', None)
    _save_room(room)

    _broadcast_room(client, room_id, _room_snapshot_payload(room, msg_type='move_undone'))

    return _response(200, {'ok': True})


def handler(event, _context):
    route_key = event['requestContext']['routeKey']

    if route_key == 'create':
        return _handle_create(event)

    if route_key == 'join':
        return _handle_join(event)

    if route_key == 'place':
        return _handle_place(event)

    if route_key == 'undo':
        return _handle_undo(event)

    if route_key == 'sync':
        return _handle_sync(event)

    connection_id = event['requestContext']['connectionId']
    client = _ws_client(event)
    _send_error(client, connection_id, f'unsupported action for route {route_key}')
    return _response(400, {'ok': False})
