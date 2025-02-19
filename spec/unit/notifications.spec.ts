/*
Copyright 2022 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import {
    EventType,
    fixNotificationCountOnDecryption,
    MatrixClient,
    MatrixEvent,
    MsgType,
    NotificationCountType,
    RelationType,
    Room,
} from "../../src/matrix";
import { IActionsObject } from "../../src/pushprocessor";
import { ReEmitter } from "../../src/ReEmitter";
import { getMockClientWithEventEmitter, mockClientMethodsUser } from "../test-utils/client";
import { mkEvent, mock } from "../test-utils/test-utils";

let mockClient: MatrixClient;
let room: Room;
let event: MatrixEvent;
let threadEvent: MatrixEvent;

const ROOM_ID = "!roomId:example.org";
let THREAD_ID;

function mkPushAction(notify, highlight): IActionsObject {
    return {
        notify,
        tweaks: {
            highlight,
        },
    };
}

describe("fixNotificationCountOnDecryption", () => {
    beforeEach(() => {
        mockClient = getMockClientWithEventEmitter({
            ...mockClientMethodsUser(),
            getPushActionsForEvent: jest.fn().mockReturnValue(mkPushAction(true, true)),
            getRoom: jest.fn().mockImplementation(() => room),
            decryptEventIfNeeded: jest.fn().mockResolvedValue(void 0),
            supportsExperimentalThreads: jest.fn().mockReturnValue(true),
        });
        mockClient.reEmitter = mock(ReEmitter, 'ReEmitter');

        room = new Room(ROOM_ID, mockClient, mockClient.getUserId());
        room.setUnreadNotificationCount(NotificationCountType.Total, 1);
        room.setUnreadNotificationCount(NotificationCountType.Highlight, 0);

        event = mkEvent({
            type: EventType.RoomMessage,
            content: {
                msgtype: MsgType.Text,
                body: "Hello world!",
            },
            event: true,
        }, mockClient);

        THREAD_ID = event.getId();
        threadEvent = mkEvent({
            type: EventType.RoomMessage,
            content: {
                "m.relates_to": {
                    rel_type: RelationType.Thread,
                    event_id: THREAD_ID,
                },
                "msgtype": MsgType.Text,
                "body": "Thread reply",
            },
            event: true,
        });
        room.createThread(THREAD_ID, event, [threadEvent], false);

        room.setThreadUnreadNotificationCount(THREAD_ID, NotificationCountType.Total, 1);
        room.setThreadUnreadNotificationCount(THREAD_ID, NotificationCountType.Highlight, 0);

        event.getPushActions = jest.fn().mockReturnValue(mkPushAction(false, false));
        threadEvent.getPushActions = jest.fn().mockReturnValue(mkPushAction(false, false));
    });

    it("changes the room count to highlight on decryption", () => {
        expect(room.getUnreadNotificationCount(NotificationCountType.Total)).toBe(1);
        expect(room.getUnreadNotificationCount(NotificationCountType.Highlight)).toBe(0);

        fixNotificationCountOnDecryption(mockClient, event);

        expect(room.getUnreadNotificationCount(NotificationCountType.Total)).toBe(1);
        expect(room.getUnreadNotificationCount(NotificationCountType.Highlight)).toBe(1);
    });

    it("changes the thread count to highlight on decryption", () => {
        expect(room.getThreadUnreadNotificationCount(THREAD_ID, NotificationCountType.Total)).toBe(1);
        expect(room.getThreadUnreadNotificationCount(THREAD_ID, NotificationCountType.Highlight)).toBe(0);

        fixNotificationCountOnDecryption(mockClient, threadEvent);

        expect(room.getThreadUnreadNotificationCount(THREAD_ID, NotificationCountType.Total)).toBe(1);
        expect(room.getThreadUnreadNotificationCount(THREAD_ID, NotificationCountType.Highlight)).toBe(1);
    });
});
