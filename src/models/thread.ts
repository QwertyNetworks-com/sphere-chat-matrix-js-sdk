/*
Copyright 2021 The Matrix.org Foundation C.I.C.

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

import {Optional} from "matrix-events-sdk";

import {
    DuplicateStrategy,
    IContextResponse,
    MatrixClient,
    MatrixEventEvent,
    Method,
    RelationType,
    RoomEvent
} from "../matrix";
import {TypedReEmitter} from "../ReEmitter";
import {IThreadBundledRelationship, MatrixEvent} from "./event";
import {EventTimeline} from "./event-timeline";
import {EventTimelineSet, EventTimelineSetHandlerMap} from './event-timeline-set';
import {Room} from './room';
import {RoomState} from "./room-state";
import {ServerControlledNamespacedValue} from "../NamespacedValue";
import {logger} from "../logger";
import {ReadReceipt} from "./read-receipt";
import * as utils from "../utils";

export enum ThreadEvent {
    New = "Thread.new",
    Update = "Thread.update",
    NewReply = "Thread.newReply",
    ViewThread = "Thread.viewThread",
}

type EmittedEvents = Exclude<ThreadEvent, ThreadEvent.New>
    | RoomEvent.Timeline
    | RoomEvent.TimelineReset;

export type EventHandlerMap = {
    [ThreadEvent.Update]: (thread: Thread) => void;
    [ThreadEvent.NewReply]: (thread: Thread, event: MatrixEvent) => void;
    [ThreadEvent.ViewThread]: () => void;
} & EventTimelineSetHandlerMap;

interface IThreadOpts {
    room: Room;
    client: MatrixClient;
}

export enum FeatureSupport {
    None = 0,
    Experimental = 1,
    Stable = 2
}

export function determineFeatureSupport(stable: boolean, unstable: boolean): FeatureSupport {
    if (stable) {
        return FeatureSupport.Stable;
    } else if (unstable) {
        return FeatureSupport.Experimental;
    } else {
        return FeatureSupport.None;
    }
}

/**
 * @experimental
 */
export class Thread extends ReadReceipt<EmittedEvents, EventHandlerMap> {
    public static hasServerSideSupport = FeatureSupport.None;
    public static hasServerSideListSupport = FeatureSupport.None;

    /**
     * A reference to all the events ID at the bottom of the threads
     */
    public readonly timelineSet: EventTimelineSet;

    private _currentUserParticipated = false;

    private reEmitter: TypedReEmitter<EmittedEvents, EventHandlerMap>;

    private lastEvent: MatrixEvent;
    private replyCount = 0;

    public readonly room: Room;
    public readonly client: MatrixClient;

    constructor(
        public readonly id: string,
        public rootEvent: MatrixEvent | undefined,
        opts: IThreadOpts,
    ) {
        super();

        if (!opts?.room) {
            // Logging/debugging for https://github.com/vector-im/element-web/issues/22141
            // Hope is that we end up with a more obvious stack trace.
            throw new Error("element-web#22141: A thread requires a room in order to function");
        }

        this.room = opts.room;
        this.client = opts.client;
        this.timelineSet = new EventTimelineSet(this.room, {
            timelineSupport: true,
            pendingEvents: true,
        }, this.client, this);
        this.reEmitter = new TypedReEmitter(this);

        this.reEmitter.reEmit(this.timelineSet, [
            RoomEvent.Timeline,
            RoomEvent.TimelineReset,
        ]);

        this.room.on(MatrixEventEvent.BeforeRedaction, this.onBeforeRedaction);
        this.room.on(RoomEvent.Redaction, this.onRedaction);
        this.room.on(RoomEvent.LocalEchoUpdated, this.onEcho);
        this.timelineSet.on(RoomEvent.Timeline, this.onEcho);

        // even if this thread is thought to be originating from this client, we initialise it as we may be in a
        // gappy sync and a thread around this event may already exist.
        this.initialiseThread();

        this.rootEvent?.setThread(this);
    }

    public static setServerSideSupport(
        status: FeatureSupport,
    ): void {
        Thread.hasServerSideSupport = status;
        if (status !== FeatureSupport.Stable) {
            FILTER_RELATED_BY_SENDERS.setPreferUnstable(true);
            FILTER_RELATED_BY_REL_TYPES.setPreferUnstable(true);
            THREAD_RELATION_TYPE.setPreferUnstable(true);
        }
    }

    public static setServerSideListSupport(
        status: FeatureSupport,
    ): void {
        Thread.hasServerSideListSupport = status;
    }

    private onBeforeRedaction = (event: MatrixEvent, redaction: MatrixEvent) => {
        if (event?.isRelation(THREAD_RELATION_TYPE.name) &&
            this.room.eventShouldLiveIn(event).threadId === this.id &&
            !redaction.status // only respect it when it succeeds
        ) {
            console.error("beforeRedaction", this.id, event);
        }
    };

    private onRedaction = (event: MatrixEvent) => {
        if (event.threadRootId !== this.id) return; // ignore redactions for other timelines

        this.replyCount--;
        console.error("redaction", this.id, this.replyCount, event);
        if (this.replyCount === 0) {
            console.error("redaction: Removing thread from room");
            this.room.threads.delete(this.id);
            console.error("redaction: Removing thread from root event");

            const timeline = this.room.getTimelineForEvent(this.id);
            const roomEvent = timeline?.getEvents()?.find(it => it.getId() === this.id);
            if (roomEvent) {
                roomEvent.setThread(null);
                delete roomEvent.event?.unsigned?.["m.relations"]?.[THREAD_RELATION_TYPE.name];
                this.rootEvent = roomEvent;

                console.error("redaction: Removing thread from events");
                for (const threadEvent of this.events) {
                    delete threadEvent?.event?.unsigned?.["m.relations"]?.[THREAD_RELATION_TYPE.name];
                    threadEvent.setThread(null);
                }
                console.error("redaction: Removing from thread list");
                for (const timelineSet of this.room.threadsTimelineSets) {
                    console.error("removed: ", Boolean(timelineSet.removeEvent(this.id)));
                }
                console.error("redaction: Adding thread events to room");
                this.room.addLiveEvents(this.events);
                console.error("redaction: Emitting events");
                this.room.emit(RoomEvent.TimelineRefresh, this.room, timeline.getTimelineSet())
            } else {
                console.error("redaction: Could not find root event in room timeline");
            }
        }
        this.emit(ThreadEvent.Update, this);
    };

    private async loadEvent(event: string): Promise<MatrixEvent | null> {
        const path = utils.encodeUri(
            "/rooms/$roomId/context/$eventId", {
                $roomId: this.roomId,
                $eventId: event,
            },
        );

        // TODO: we should implement a backoff (as per scrollback()) to deal more nicely with HTTP errors.
        const res = await this.client.http.authedRequest<IContextResponse>(undefined, Method.Get, path, {
            limit: "0",
        });
        if (!res.event) {
            throw new Error("'event' not in '/context' result - homeserver too old?");
        }

        const mapper = this.client.getEventMapper();
        const mappedEvent = mapper(res.event);
        await this.fetchEditsWhereNeeded(mappedEvent);
        return mappedEvent;
    }

    private onEcho = async (event: MatrixEvent) => {
        if (event.threadRootId !== this.id) return; // ignore echoes for other timelines
        if (this.lastEvent === event) return;
        if (!event.isRelation(THREAD_RELATION_TYPE.name)) return;

        await this.initialiseThread();
        this.emit(ThreadEvent.NewReply, this, event);
    };

    public get roomState(): RoomState {
        return this.room.getLiveTimeline().getState(EventTimeline.FORWARDS);
    }

    private addEventToTimeline(event: MatrixEvent, toStartOfTimeline: boolean): void {
        if (!this.findEventById(event.getId())) {
            this.timelineSet.addEventToTimeline(
                event,
                this.liveTimeline,
                {
                    toStartOfTimeline,
                    fromCache: false,
                    roomState: this.roomState,
                },
            );
        }
    }

    public addEvents(events: MatrixEvent[], toStartOfTimeline: boolean): void {
        console.error("addEvents", this.id, events);
        events.forEach(ev => this.addEvent(ev, toStartOfTimeline, false));
        this.emit(ThreadEvent.Update, this);
    }

    /**
     * Add an event to the thread and updates
     * the tail/root references if needed
     * Will fire "Thread.update"
     * @param event The event to add
     * @param {boolean} toStartOfTimeline whether the event is being added
     * to the start (and not the end) of the timeline.
     * @param {boolean} emit whether to emit the Update event if the thread was updated or not.
     */
    public addEvent(event: MatrixEvent, toStartOfTimeline: boolean, emit = true): void {
        console.error("addEvent", this.id, event);
        event.setThread(this);

        if (!this._currentUserParticipated && event.getSender() === this.client.getUserId()) {
            this._currentUserParticipated = true;
        }

        // Add all incoming events to the thread's timeline set when there's  no server support
        if (!Thread.hasServerSideSupport) {
            // all the relevant membership info to hydrate events with a sender
            // is held in the main room timeline
            // We want to fetch the room state from there and pass it down to this thread
            // timeline set to let it reconcile an event with its relevant RoomMember
            this.addEventToTimeline(event, toStartOfTimeline);

            this.client.decryptEventIfNeeded(event, {});
        } else if (!toStartOfTimeline &&
            event.localTimestamp > this.lastReply()?.localTimestamp
        ) {
            this.fetchEditsWhereNeeded(event);
            this.addEventToTimeline(event, false);
        } else if (event.isRelation(RelationType.Annotation) || event.isRelation(RelationType.Replace)) {
            // Apply annotations and replace relations to the relations of the timeline only
            this.timelineSet.relations.aggregateParentEvent(event);
            this.timelineSet.relations.aggregateChildEvent(event, this.timelineSet);
            return;
        }

        // If no thread support exists we want to count all thread relation
        // added as a reply. We can't rely on the bundled relationships count
        if ((!Thread.hasServerSideSupport || !this.rootEvent) && event.isRelation(THREAD_RELATION_TYPE.name)) {
            this.replyCount++;
        }

        if (emit) {
            this.emit(ThreadEvent.NewReply, this, event);
        }
    }

    private async initialiseThread(): Promise<void> {
        const mapper = this.client.getEventMapper();
        const mappedEvent = await this.loadEvent(this.id);
        EventTimeline.setEventMetadata(mappedEvent, this.roomState, false);
        mappedEvent.setThread(this);

        const metadata = mappedEvent?.getServerAggregatedRelation<IThreadBundledRelationship>(THREAD_RELATION_TYPE.name);
        if (metadata) {
            this.replyCount = metadata.count;
            const latestEvent = mapper(metadata.latest_event);
            await this.fetchEditsWhereNeeded(latestEvent);
            this.lastEvent = latestEvent;
            this.rootEvent = mappedEvent;

            console.error("initialiseThread", this.id, event, metadata);

            console.error("initialiseThread: Replacing in thread list");
            for (const timelineSet of this.room.threadsTimelineSets) {
                timelineSet.removeEvent(this.id);
                timelineSet.addLiveEvent(mappedEvent, {
                    duplicateStrategy: DuplicateStrategy.Replace,
                    fromCache: false,
                    roomState: this.roomState,
                });
            }
            const timeline = this.room.getTimelineForEvent(this.id);
            const roomEvent = timeline?.getEvents()?.find(it => it.getId() === this.id);
            if (roomEvent) {
                roomEvent.event = mappedEvent.event;
                roomEvent.setThread(this);
                console.error("initialiseThread: Replacing root event in room timeline", roomEvent);
            } else {
                console.error("initialiseThread: Could not find root event in room timeline");
            }
            console.error("initialiseThread: Emitting events");
            this.room.emit(RoomEvent.TimelineRefresh, this.room, timeline.getTimelineSet());
            this.room.emit(RoomEvent.TimelineRefresh, this.room, this.timelineSet);
            this.emit(ThreadEvent.Update, this);
        } else {
            console.error("initialiseThread failed: metadata was falsy", mappedEvent);
        }
    }

    // XXX: Workaround for https://github.com/matrix-org/matrix-spec-proposals/pull/2676/files#r827240084
    public async fetchEditsWhereNeeded(...events: MatrixEvent[]): Promise<unknown> {
        return Promise.all(events.filter(e => e.isEncrypted()).map((event: MatrixEvent) => {
            if (event.isRelation()) return; // skip - relations don't get edits
            return this.client.relations(this.roomId, event.getId(), RelationType.Replace, event.getType(), {
                limit: 1,
            }).then(relations => {
                if (relations.events.length) {
                    event.makeReplaced(relations.events[0]);
                }
            }).catch(e => {
                logger.error("Failed to load edits for encrypted thread event", e);
            });
        }));
    }

    /**
     * Finds an event by ID in the current thread
     */
    public findEventById(eventId: string) {
        // Check the lastEvent as it may have been created based on a bundled relationship and not in a timeline
        if (this.lastEvent?.getId() === eventId) {
            return this.lastEvent;
        }

        return this.timelineSet.findEventById(eventId);
    }

    /**
     * Return last reply to the thread, if known.
     */
    public lastReply(matches: (ev: MatrixEvent) => boolean = () => true): MatrixEvent | null {
        for (let i = this.events.length - 1; i >= 0; i--) {
            const event = this.events[i];
            if (matches(event)) {
                return event;
            }
        }
        return null;
    }

    public get roomId(): string {
        return this.room.roomId;
    }

    /**
     * The number of messages in the thread
     * Only count rel_type=m.thread as we want to
     * exclude annotations from that number
     */
    public get length(): number {
        return this.replyCount;
    }

    /**
     * A getter for the last event added to the thread, if known.
     */
    public get replyToEvent(): Optional<MatrixEvent> {
        return this.lastEvent ?? this.lastReply();
    }

    public get events(): MatrixEvent[] {
        return this.liveTimeline.getEvents();
    }

    public has(eventId: string): boolean {
        return this.timelineSet.findEventById(eventId) instanceof MatrixEvent;
    }

    public get hasCurrentUserParticipated(): boolean {
        return this._currentUserParticipated;
    }

    public get liveTimeline(): EventTimeline {
        return this.timelineSet.getLiveTimeline();
    }

    public getUnfilteredTimelineSet(): EventTimelineSet {
        return this.timelineSet;
    }

    public get timeline(): MatrixEvent[] {
        return this.events;
    }

    public addReceipt(event: MatrixEvent, synthetic: boolean): void {
        throw new Error("Unsupported function on the thread model");
    }
}

export const FILTER_RELATED_BY_SENDERS = new ServerControlledNamespacedValue(
    "related_by_senders",
    "io.element.relation_senders",
);
export const FILTER_RELATED_BY_REL_TYPES = new ServerControlledNamespacedValue(
    "related_by_rel_types",
    "io.element.relation_types",
);
export const THREAD_RELATION_TYPE = new ServerControlledNamespacedValue(
    "m.thread",
    "io.element.thread",
);

export enum ThreadFilterType {
    "My",
    "All"
}
