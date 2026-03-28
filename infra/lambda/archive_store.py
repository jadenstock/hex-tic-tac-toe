import json
import os
import time
import uuid
from typing import Any, Dict

import boto3
from botocore.exceptions import ClientError

archive_bucket = os.environ['ARCHIVE_BUCKET']
s3_client = boto3.client('s3')


def new_game_id() -> str:
    return uuid.uuid4().hex


def normalize_move_history(raw_history: Any) -> list[Dict[str, Any]]:
    if not isinstance(raw_history, list):
        return []

    normalized: list[Dict[str, Any]] = []
    for idx, move in enumerate(raw_history):
        if not isinstance(move, dict):
            continue

        mark = str(move.get('mark', '')).upper()
        if mark not in ('X', 'O'):
            continue

        try:
            q = int(move.get('q'))
            r = int(move.get('r'))
        except (TypeError, ValueError):
            continue

        actor_type = str(move.get('actorType', '')).lower()
        if actor_type not in ('human', 'bot'):
            actor_type = ''

        normalized_move: Dict[str, Any] = {
            'ply': idx + 1,
            'q': q,
            'r': r,
            'mark': mark,
        }
        if actor_type:
            normalized_move['actorType'] = actor_type

        normalized.append(normalized_move)

    return normalized


def build_board_from_history(move_history: list[Dict[str, Any]]) -> Dict[str, str]:
    board: Dict[str, str] = {}
    for move in move_history:
        board[f"{move['q']},{move['r']}"] = move['mark']
    return board


def _normalize_participant(raw: Any, mark: str) -> Dict[str, Any]:
    default_label = f'Player {mark}'
    if not isinstance(raw, dict):
        return {'type': 'human', 'label': default_label}

    participant_type = str(raw.get('type', 'human')).lower()
    if participant_type not in ('human', 'bot'):
        participant_type = 'human'

    participant: Dict[str, Any] = {
        'type': participant_type,
        'label': str(raw.get('label') or ('Hex Bot' if participant_type == 'bot' else default_label)),
    }

    for key in ('botId', 'botVersion', 'userId'):
        value = raw.get(key)
        if value not in (None, ''):
            participant[key] = value

    return participant


def normalize_participants(raw: Any) -> Dict[str, Dict[str, Any]]:
    source = raw if isinstance(raw, dict) else {}
    return {
        'X': _normalize_participant(source.get('X'), 'X'),
        'O': _normalize_participant(source.get('O'), 'O'),
    }


def infer_status(move_history: list[Dict[str, Any]], winner: str | None, requested_status: str | None = None) -> str:
    if requested_status in ('pending', 'active', 'completed', 'abandoned', 'snapshot'):
        return requested_status
    if winner:
        return 'completed'
    if move_history:
        return 'active'
    return 'pending'


def infer_result_type(status: str, winner: str | None, requested_result_type: str | None = None) -> str | None:
    if requested_result_type in ('win', 'abandoned', 'snapshot', 'draw'):
        return requested_result_type
    if winner:
        return 'win'
    if status == 'snapshot':
        return 'snapshot'
    if status == 'abandoned':
        return 'abandoned'
    return None


def archive_key_for_game(game_id: str) -> str:
    return f'games/{game_id}.json'


def build_archive_payload(game: Dict[str, Any]) -> Dict[str, Any]:
    move_history = normalize_move_history(game.get('moveHistory', []))
    participants = normalize_participants(game.get('participants'))
    winner = game.get('winner')
    if winner not in ('X', 'O'):
        winner = None

    status = infer_status(move_history, winner, game.get('status'))
    result_type = infer_result_type(status, winner, game.get('resultType'))
    final_board = build_board_from_history(move_history)

    payload: Dict[str, Any] = {
        'gameId': game['gameId'],
        'roomId': game.get('roomId'),
        'status': status,
        'createdAt': int(game.get('createdAt') or time.time()),
        'updatedAt': int(game.get('updatedAt') or time.time()),
        'startedAt': game.get('startedAt') or game.get('createdAt'),
        'endedAt': game.get('endedAt'),
        'visibility': str(game.get('visibility') or 'public'),
        'gameMode': str(game.get('gameMode') or 'live'),
        'participants': participants,
        'winner': winner,
        'resultType': result_type,
        'moveHistory': move_history,
        'finalBoard': final_board,
    }

    archive_key = game.get('archiveKey')
    if archive_key:
        payload['archiveKey'] = archive_key

    return payload


def write_archive(game: Dict[str, Any]) -> str:
    payload = build_archive_payload(game)
    key = archive_key_for_game(payload['gameId'])

    s3_client.put_object(
        Bucket=archive_bucket,
        Key=key,
        Body=json.dumps(payload, separators=(',', ':')).encode('utf-8'),
        CacheControl='no-cache',
        ContentType='application/json',
    )

    return key


def load_archive(game_id: str) -> Dict[str, Any] | None:
    try:
        response = s3_client.get_object(Bucket=archive_bucket, Key=archive_key_for_game(game_id))
    except ClientError as exc:
        if exc.response.get('Error', {}).get('Code') in ('NoSuchKey', '404'):
            return None
        raise

    body = response['Body'].read()
    return json.loads(body)
