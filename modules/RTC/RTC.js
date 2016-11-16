/* global Strophe */

var logger = require("jitsi-meet-logger").getLogger(__filename);
var EventEmitter = require("events");
var RTCEvents = require("../../service/RTC/RTCEvents.js");
var RTCUtils = require("./RTCUtils.js");
var JitsiLocalTrack = require("./JitsiLocalTrack.js");
import JitsiTrackError from "../../JitsiTrackError";
import * as JitsiTrackErrors from "../../JitsiTrackErrors";
var DataChannels = require("./DataChannels");
var JitsiRemoteTrack = require("./JitsiRemoteTrack.js");
var MediaType = require("../../service/RTC/MediaType");
var VideoType = require("../../service/RTC/VideoType");
var GlobalOnErrorHandler = require("../util/GlobalOnErrorHandler");

function createLocalTracks(tracksInfo, options) {
    var newTracks = [];
    var deviceId = null;
    tracksInfo.forEach(function(trackInfo){
        if (trackInfo.mediaType === MediaType.AUDIO) {
            deviceId = options.micDeviceId;
        } else if (trackInfo.videoType === VideoType.CAMERA){
            deviceId = options.cameraDeviceId;
        }
        var localTrack
            = new JitsiLocalTrack(
                trackInfo.stream,
                trackInfo.track,
                trackInfo.mediaType,
                trackInfo.videoType,
                trackInfo.resolution,
                deviceId,
                options.facingMode);
        newTracks.push(localTrack);
    });
    return newTracks;
}

function RTC(conference, options) {
    this.conference = conference;
    this.localTracks = [];
    //FIXME: We should support multiple streams per jid.
    this.remoteTracks = {};
    this.localAudio = null;
    this.localVideo = null;
    this.eventEmitter = new EventEmitter();
    var self = this;
    this.options = options || {};
    // A flag whether we had received that the data channel had opened
    // we can get this flag out of sync if for some reason data channel got
    // closed from server, a desired behaviour so we can see errors when this
    // happen
    this.dataChannelsOpen = false;

    // Switch audio output device on all remote audio tracks. Local audio tracks
    // handle this event by themselves.
    if (RTCUtils.isDeviceChangeAvailable('output')) {
        RTCUtils.addListener(RTCEvents.AUDIO_OUTPUT_DEVICE_CHANGED,
            function (deviceId) {
                for (var key in self.remoteTracks) {
                    if (self.remoteTracks.hasOwnProperty(key)
                        && self.remoteTracks[key].audio) {
                        self.remoteTracks[key].audio.setAudioOutput(deviceId);
                    }
                }
            });
    }
}

/**
 * Creates the local MediaStreams.
 * @param {Object} [options] optional parameters
 * @param {Array} options.devices the devices that will be requested
 * @param {string} options.resolution resolution constraints
 * @param {bool} options.dontCreateJitsiTrack if <tt>true</tt> objects with the
 * following structure {stream: the Media Stream,
 * type: "audio" or "video", videoType: "camera" or "desktop"}
 * will be returned trough the Promise, otherwise JitsiTrack objects will be
 * returned.
 * @param {string} options.cameraDeviceId
 * @param {string} options.micDeviceId
 * @returns {*} Promise object that will receive the new JitsiTracks
 */

RTC.obtainAudioAndVideoPermissions = function (options) {
    return RTCUtils.obtainAudioAndVideoPermissions(options).then(
        function (tracksInfo) {
            var tracks = createLocalTracks(tracksInfo, options);
            return !tracks.some(track => !track._isReceivingData())? tracks :
                Promise.reject(new JitsiTrackError(
                    JitsiTrackErrors.NO_DATA_FROM_SOURCE));
    });
};

RTC.prototype.onIncommingCall = function(event) {
    if(this.options.config.openSctp) {
        this.dataChannels = new DataChannels(event.peerconnection,
            this.eventEmitter);
        this._dataChannelOpenListener = () => {
            // mark that dataChannel is opened
            this.dataChannelsOpen = true;
            // when the data channel becomes available, tell the bridge
            // about video selections so that it can do adaptive simulcast,
            // we want the notification to trigger even if userJid
            // is undefined, or null.
            // XXX why do we not do the same for pinned endpoints?
            try {
                this.dataChannels.sendSelectedEndpointMessage(
                    this.selectedEndpoint);
            } catch (error) {
                GlobalOnErrorHandler.callErrorHandler(error);
                logger.error("Cannot sendSelectedEndpointMessage ",
                    this.selectedEndpoint, ". Error: ", error);
            }

            this.removeListener(RTCEvents.DATA_CHANNEL_OPEN,
                this._dataChannelOpenListener);
            this._dataChannelOpenListener = null;
        };
        this.addListener(RTCEvents.DATA_CHANNEL_OPEN,
            this._dataChannelOpenListener);
    }
};

/**
 * Should be called when current media session ends and after the PeerConnection
 * has been closed using PeerConnection.close() method.
 */
RTC.prototype.onCallEnded = function() {
    if (this.dataChannels) {
        // DataChannels are not explicitly closed as the PeerConnection
        // is closed on call ended which triggers data channel onclose events.
        // The reference is cleared to disable any logic related to the data
        // channels.
        this.dataChannels = null;
        this.dataChannelsOpen = false;
    }
};

/**
 * Elects the participant with the given id to be the selected participant in
 * order to always receive video for this participant (even when last n is
 * enabled).
 * If there is no data channel we store it and send it through the channel once
 * it is created.
 * @param id {string} the user id.
 * @throws NetworkError or InvalidStateError or Error if the operation fails.
*/
RTC.prototype.selectEndpoint = function (id) {
    // cache the value if channel is missing, till we open it
    this.selectedEndpoint = id;
    if(this.dataChannels && this.dataChannelsOpen)
        this.dataChannels.sendSelectedEndpointMessage(id);
};

/**
 * Elects the participant with the given id to be the pinned participant in
 * order to always receive video for this participant (even when last n is
 * enabled).
 * @param id {string} the user id
 * @throws NetworkError or InvalidStateError or Error if the operation fails.
 */
RTC.prototype.pinEndpoint = function (id) {
    if(this.dataChannels) {
        this.dataChannels.sendPinnedEndpointMessage(id);
    } else {
        // FIXME: cache value while there is no data channel created
        // and send the cached state once channel is created
        throw new Error("Data channels support is disabled!");
    }
};

RTC.prototype.addListener = function (type, listener) {
    this.eventEmitter.on(type, listener);
};

RTC.prototype.removeListener = function (eventType, listener) {
    this.eventEmitter.removeListener(eventType, listener);
};

RTC.addListener = function (eventType, listener) {
    RTCUtils.addListener(eventType, listener);
};

RTC.removeListener = function (eventType, listener) {
    RTCUtils.removeListener(eventType, listener);
};

RTC.isRTCReady = function () {
    return RTCUtils.isRTCReady();
};

RTC.init = function (options) {
    this.options = options || {};
    return RTCUtils.init(this.options);
};

RTC.getDeviceAvailability = function () {
    return RTCUtils.getDeviceAvailability();
};

RTC.prototype.addLocalTrack = function (track) {
    if (!track)
        throw new Error('track must not be null nor undefined');

    this.localTracks.push(track);

    track.conference = this.conference;

    if (track.isAudioTrack()) {
        this.localAudio = track;
    } else {
        this.localVideo = track;
    }
};

/**
 * Get local video track.
 * @returns {JitsiLocalTrack}
 */
RTC.prototype.getLocalVideoTrack = function () {
    return this.localVideo;
};

/**
 * Gets JitsiRemoteTrack for the passed MediaType associated with given MUC
 * nickname (resource part of the JID).
 * @param type audio or video.
 * @param resource the resource part of the MUC JID
 * @returns {JitsiRemoteTrack|null}
 */
RTC.prototype.getRemoteTrackByType = function (type, resource) {
    if (this.remoteTracks[resource])
        return this.remoteTracks[resource][type];
    else
        return null;
};

/**
 * Gets JitsiRemoteTrack for AUDIO MediaType associated with given MUC nickname
 * (resource part of the JID).
 * @param resource the resource part of the MUC JID
 * @returns {JitsiRemoteTrack|null}
 */
RTC.prototype.getRemoteAudioTrack = function (resource) {
    return this.getRemoteTrackByType(MediaType.AUDIO, resource);
};

/**
 * Gets JitsiRemoteTrack for VIDEO MediaType associated with given MUC nickname
 * (resource part of the JID).
 * @param resource the resource part of the MUC JID
 * @returns {JitsiRemoteTrack|null}
 */
RTC.prototype.getRemoteVideoTrack = function (resource) {
    return this.getRemoteTrackByType(MediaType.VIDEO, resource);
};

/**
 * Set mute for all local audio streams attached to the conference.
 * @param value the mute value
 * @returns {Promise}
 */
RTC.prototype.setAudioMute = function (value) {
    var mutePromises = [];
    for(var i = 0; i < this.localTracks.length; i++) {
        var track = this.localTracks[i];
        if(track.getType() !== MediaType.AUDIO) {
            continue;
        }
        // this is a Promise
        mutePromises.push(value ? track.mute() : track.unmute());
    }
    // we return a Promise from all Promises so we can wait for their execution
    return Promise.all(mutePromises);
};

RTC.prototype.removeLocalTrack = function (track) {
    var pos = this.localTracks.indexOf(track);
    if (pos === -1) {
        return;
    }

    this.localTracks.splice(pos, 1);

    if (track.isAudioTrack()) {
        this.localAudio = null;
    } else {
        this.localVideo = null;
    }
};

/**
 * Initializes a new JitsiRemoteTrack instance with the data provided by (a)
 * ChatRoom to XMPPEvents.REMOTE_TRACK_ADDED.
 *
 * @param {Object} event the data provided by (a) ChatRoom to
 * XMPPEvents.REMOTE_TRACK_ADDED to (a)
 */
RTC.prototype.createRemoteTrack = function (event) {
    var ownerJid = event.owner;
    var remoteTrack = new JitsiRemoteTrack(
        this, this.conference, ownerJid, event.stream, event.track,
        event.mediaType, event.videoType, event.ssrc, event.muted);
    var resource = Strophe.getResourceFromJid(ownerJid);
    var remoteTracks
        = this.remoteTracks[resource] || (this.remoteTracks[resource] = {});
    var mediaType = remoteTrack.getType();
    if (remoteTracks[mediaType]) {
        logger.warn("Overwriting remote track!", resource, mediaType);
    }
    remoteTracks[mediaType] = remoteTrack;
    return remoteTrack;
};

/**
 * Removes all JitsiRemoteTracks associated with given MUC nickname (resource
 * part of the JID). Returns array of removed tracks.
 *
 * @param {string} resource - The resource part of the MUC JID.
 * @returns {JitsiRemoteTrack[]}
 */
RTC.prototype.removeRemoteTracks = function (resource) {
    var removedTracks = [];
    var removedAudioTrack = this.removeRemoteTrack(resource, MediaType.AUDIO);
    var removedVideoTrack = this.removeRemoteTrack(resource, MediaType.VIDEO);

    removedAudioTrack && removedTracks.push(removedAudioTrack);
    removedVideoTrack && removedTracks.push(removedVideoTrack);

    delete this.remoteTracks[resource];

    return removedTracks;
};

/**
 * Removes specified track type associated with given MUC nickname
 * (resource part of the JID). Returns removed track if any.
 *
 * @param {string} resource - The resource part of the MUC JID.
 * @param {string} mediaType - Type of track to remove.
 * @returns {JitsiRemoteTrack|undefined}
 */
RTC.prototype.removeRemoteTrack = function (resource, mediaType) {
    var remoteTracksForResource = this.remoteTracks[resource];

    if (remoteTracksForResource && remoteTracksForResource[mediaType]) {
        var track = remoteTracksForResource[mediaType];
        track.dispose();
        delete remoteTracksForResource[mediaType];
        return track;
    }
};

RTC.getPCConstraints = function () {
    return RTCUtils.pc_constraints;
};

RTC.attachMediaStream =  function (elSelector, stream) {
    return RTCUtils.attachMediaStream(elSelector, stream);
};

RTC.getStreamID = function (stream) {
    return RTCUtils.getStreamID(stream);
};

/**
 * Returns true if retrieving the the list of input devices is supported and
 * false if not.
 */
RTC.isDeviceListAvailable = function () {
    return RTCUtils.isDeviceListAvailable();
};

/**
 * Returns true if changing the input (camera / microphone) or output
 * (audio) device is supported and false if not.
 * @params {string} [deviceType] - type of device to change. Default is
 *      undefined or 'input', 'output' - for audio output device change.
 * @returns {boolean} true if available, false otherwise.
 */
RTC.isDeviceChangeAvailable = function (deviceType) {
    return RTCUtils.isDeviceChangeAvailable(deviceType);
};

/**
 * Returns currently used audio output device id, '' stands for default
 * device
 * @returns {string}
 */
RTC.getAudioOutputDevice = function () {
    return RTCUtils.getAudioOutputDevice();
};

/**
 * Returns list of available media devices if its obtained, otherwise an
 * empty array is returned/
 * @returns {Array} list of available media devices.
 */
RTC.getCurrentlyAvailableMediaDevices = function () {
    return RTCUtils.getCurrentlyAvailableMediaDevices();
};

/**
 * Returns event data for device to be reported to stats.
 * @returns {MediaDeviceInfo} device.
 */
RTC.getEventDataForActiveDevice = function (device) {
    return RTCUtils.getEventDataForActiveDevice(device);
};

/**
 * Sets current audio output device.
 * @param {string} deviceId - id of 'audiooutput' device from
 *      navigator.mediaDevices.enumerateDevices()
 * @returns {Promise} - resolves when audio output is changed, is rejected
 *      otherwise
 */
RTC.setAudioOutputDevice = function (deviceId) {
    return RTCUtils.setAudioOutputDevice(deviceId);
};

/**
 * Returns <tt>true<tt/> if given WebRTC MediaStream is considered a valid
 * "user" stream which means that it's not a "receive only" stream nor a "mixed"
 * JVB stream.
 *
 * Clients that implement Unified Plan, such as Firefox use recvonly
 * "streams/channels/tracks" for receiving remote stream/tracks, as opposed to
 * Plan B where there are only 3 channels: audio, video and data.
 *
 * @param stream WebRTC MediaStream instance
 * @returns {boolean}
 */
RTC.isUserStream = function (stream) {
    var streamId = RTCUtils.getStreamID(stream);
    return streamId && streamId !== "mixedmslabel" && streamId !== "default";
};

/**
 * Allows to receive list of available cameras/microphones.
 * @param {function} callback would receive array of devices as an argument
 */
RTC.enumerateDevices = function (callback) {
    RTCUtils.enumerateDevices(callback);
};

/**
 * A method to handle stopping of the stream.
 * One point to handle the differences in various implementations.
 * @param mediaStream MediaStream object to stop.
 */
RTC.stopMediaStream = function (mediaStream) {
    RTCUtils.stopMediaStream(mediaStream);
};

/**
 * Returns whether the desktop sharing is enabled or not.
 * @returns {boolean}
 */
RTC.isDesktopSharingEnabled = function () {
    return RTCUtils.isDesktopSharingEnabled();
};

/**
 * Closes all currently opened data channels.
 */
RTC.prototype.closeAllDataChannels = function () {
    if(this.dataChannels) {
        this.dataChannels.closeAllChannels();
        this.dataChannelsOpen = false;
    }
};

RTC.prototype.dispose = function() {
};

/*
 //FIXME Never used, but probably *should* be used for switching
 //      between camera and screen, but has to be adjusted to work with tracks.
 //      Current when switching to desktop we can see recv-only being advertised
 //      because we do remove and add.
 //
 //      Leaving it commented out, in order to not forget about FF specific
 //      thing
RTC.prototype.switchVideoTracks = function (newStream) {
    this.localVideo.stream = newStream;

    this.localTracks = [];

    //in firefox we have only one stream object
    if (this.localAudio.getOriginalStream() != newStream)
        this.localTracks.push(this.localAudio);
    this.localTracks.push(this.localVideo);
};*/

RTC.prototype.setAudioLevel = function (resource, audioLevel) {
    if(!resource)
        return;
    var audioTrack = this.getRemoteAudioTrack(resource);
    if(audioTrack) {
        audioTrack.setAudioLevel(audioLevel);
    }
};

/**
 * Searches in localTracks(session stores ssrc for audio and video) and
 * remoteTracks for the ssrc and returns the corresponding resource.
 * @param ssrc the ssrc to check.
 */
RTC.prototype.getResourceBySSRC = function (ssrc) {
    if((this.localVideo && ssrc == this.localVideo.getSSRC())
        || (this.localAudio && ssrc == this.localAudio.getSSRC())) {
        return this.conference.myUserId();
    }

    var track = this.getRemoteTrackBySSRC(ssrc);
    return track? track.getParticipantId() : null;
};

/**
 * Searches in remoteTracks for the ssrc and returns the corresponding track.
 * @param ssrc the ssrc to check.
 */
RTC.prototype.getRemoteTrackBySSRC = function (ssrc) {
    for (var resource in this.remoteTracks) {
        var track = this.getRemoteAudioTrack(resource);
        if(track && track.getSSRC() == ssrc) {
            return track;
        }
        track = this.getRemoteVideoTrack(resource);
        if(track && track.getSSRC() == ssrc) {
            return track;
        }
    }
    return null;
};

/**
 * Handles remote track mute / unmute events.
 * @param type {string} "audio" or "video"
 * @param isMuted {boolean} the new mute state
 * @param from {string} user id
 */
RTC.prototype.handleRemoteTrackMute = function (type, isMuted, from) {
    var track = this.getRemoteTrackByType(type, from);
    if (track) {
        track.setMute(isMuted);
    }
};

/**
 * Handles remote track video type events
 * @param value {string} the new video type
 * @param from {string} user id
 */
RTC.prototype.handleRemoteTrackVideoTypeChanged = function (value, from) {
    var videoTrack = this.getRemoteVideoTrack(from);
    if (videoTrack) {
        videoTrack._setVideoType(value);
    }
};

/**
 * Sends message via the datachannels.
 * @param to {string} the id of the endpoint that should receive the message.
 * If "" the message will be sent to all participants.
 * @param payload {object} the payload of the message.
 * @throws NetworkError or InvalidStateError or Error if the operation fails
 * or there is no data channel created
 */
RTC.prototype.sendDataChannelMessage = function (to, payload) {
    if(this.dataChannels) {
        this.dataChannels.sendDataChannelMessage(to, payload);
    } else {
        throw new Error("Data channels support is disabled!");
    }
};

module.exports = RTC;
