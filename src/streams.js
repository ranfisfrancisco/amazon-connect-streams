/*
 * Copyright 2014-2017 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
(function() {
   var global = this || globalThis;
   var connect = global.connect || {};
   global.connect = connect;
   global.lily = connect;

   /**---------------------------------------------------------------
    * class Stream
    *
    * Represents an object from which messages can be read and to which
    * messages can be sent.
    */
   var Stream = function() {};

   /**
    * Send a message to the stream.  This method must be implemented by subclasses.
    */
   Stream.prototype.send = function(message) {
      throw new connect.NotImplementedError();
   };

   /**
    * Provide a method to be called when messages are received from this stream.
    * This method must be implemented by subclasses.
    */
   Stream.prototype.onMessage = function(f) {
      throw new connect.NotImplementedError();
   };

   /**---------------------------------------------------------------
    * class NullStream extends Stream
    *
    * A null stream which provides no message sending or receiving facilities.
    */
   var NullStream = function() {
      Stream.call(this);
   };
   NullStream.prototype = Object.create(Stream.prototype);
   NullStream.prototype.constructor = NullStream;

   NullStream.prototype.onMessage = function(f) {};
   NullStream.prototype.send = function(message) {};

   /**---------------------------------------------------------------
    * class WindowStream extends Stream
    *
    * A stream for communicating with a window object.  The domain provided
    * must match the allowed message domains of the downstream receiver
    * or messages will be rejected, see https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage
    * for more info.
    */
   var WindowStream = function(win, domain) {
      Stream.call(this);
      this.window = win;
      this.domain = domain || '*';
   };
   WindowStream.prototype = Object.create(Stream.prototype);
   WindowStream.prototype.constructor = WindowStream;

   WindowStream.prototype.send = function(message) {
      this.window.postMessage(message, this.domain);
   };

   WindowStream.prototype.onMessage = function(f) {
      this.window.addEventListener("message", f);
   };

   /**---------------------------------------------------------------
    * class WindowIOStream extends Stream
    *
    * A stream used by IFrame/popup windows to communicate with their parents
    * and vise versa.
    *
    * This object encapsulates the fact that incoming and outgoing messages
    * arrive on different windows and allows this to be managed as a single
    * Stream object.
    */
   var WindowIOStream = function(inputwin, outputwin, domain) {
      Stream.call(this);
      this.input = inputwin;
      this.output = outputwin;
      this.domain = domain || '*';
   };
   WindowIOStream.prototype = Object.create(Stream.prototype);
   WindowIOStream.prototype.constructor = WindowIOStream;

   WindowIOStream.prototype.send = function(message) {
      this.output.postMessage(message, this.domain);
   };

   WindowIOStream.prototype.onMessage = function(f) {
      this.input.addEventListener("message", (message) => {
         if (message.source === this.output) {
            f(message);
         }
      });
   };

   /**---------------------------------------------------------------
    * class PortStream extends Stream
    *
    * A stream wrapping an HTML5 Worker port.  This could be the port
    * used to connect to a Worker or one of the multitude of ports
    * made available to a SharedWorker for communication back to
    * its connected clients.
    */
   var PortStream = function(port) {
      Stream.call(this);
      this.port = port;
      this.id = connect.randomId();
   };
   PortStream.prototype = Object.create(Stream.prototype);
   PortStream.prototype.constructor = PortStream;

   PortStream.prototype.send = function(message) {
      this.port.postMessage(message);
   };

   PortStream.prototype.onMessage = function(f) {
      this.port.addEventListener("message", f);
   };

   PortStream.prototype.getId = function() {
      return this.id;
   };

   /**---------------------------------------------------------------
    * class StreamMultiplexer extends Stream
    *
    * A wrapper for multiplexed downstream communication with
    * multiple streams at once.  Mainly useful for the SharedWorker to
    * broadcast events to many PortStream objects at once.
    */
   var StreamMultiplexer = function(streams) {
      Stream.call(this);
      this.streamMap = streams ?
         connect.index(streams, function(s) { return s.getId(); }) : {};
      this.messageListeners = [];
   };
   StreamMultiplexer.prototype = Object.create(Stream.prototype);
   StreamMultiplexer.prototype.constructor = StreamMultiplexer;

   /**
    * Send a message to all ports in the multiplexer.
    */
   StreamMultiplexer.prototype.send = function(message) {
      this.getStreams().forEach(function(stream) {
         try {
            stream.send(message);

         } catch (e) {
            // Couldn't send message to one of the downstreams for some reason...
            // No reliable logging possible without further failures,
            // no recovery, just eat it.
         }
      });
   };

   /**
    * Register a method which will be called when a message is received from
    * any of the downstreams.
    */
   StreamMultiplexer.prototype.onMessage = function(f) {
      this.messageListeners.push(f);

      // Update existing streams with the new listener.
      this.getStreams().forEach(function(stream) {
         stream.onMessage(f);
      });
   };

   /**
    * Add a stream to the multiplexer.
    */
   StreamMultiplexer.prototype.addStream = function(stream) {
      var self = this;
      this.streamMap[stream.getId()] = stream;

      // Update stream with existing listeners.
      this.messageListeners.forEach(function(messageListener) {
         stream.onMessage(messageListener);
      });
   };

   /**
    * Remove the given downstream.  This is typically used in response
    * to the SharedWorker's onclose event, indicating that a consumer
    * tab has been closed.
    */
   StreamMultiplexer.prototype.removeStream = function(stream) {
      delete this.streamMap[stream.getId()];
   };

   /**
    * Get a list of streams in the multiplexer.
    */
   StreamMultiplexer.prototype.getStreams = function(stream) {
      return connect.values(this.streamMap);
   };

   /**
    * Get the stream matching the given port.
    */
   StreamMultiplexer.prototype.getStreamForPort = function(port) {
      return connect.find(this.getStreams(), function(s) {
         return s.port === port;
      });
   };

   /**---------------------------------------------------------------
    * class Conduit
    *
    * An object which bridges an upstream and a downstream, allowing messages
    * to be passed to and from each and providing an event bus for event
    * subscriptions to be made upstream and downstream.
    */
   var Conduit = function(name, upstream, downstream) {
      this.name = name;
      this.upstream = upstream || new NullStream();
      this.downstream = downstream || new NullStream();
      this.downstreamBus = new connect.EventBus();
      this.upstreamBus = new connect.EventBus();

      this.upstream.onMessage(connect.hitch(this, this._dispatchEvent, this.upstreamBus));
      this.downstream.onMessage(connect.hitch(this, this._dispatchEvent, this.downstreamBus));

      // Only relevant for Global Resiliency
      this.active = true;
      this.allowedEvents =
      [
         ...Object.entries(connect.GlobalResiliencyEvents).map((keyValue)=>{ return keyValue[1] }),
         connect.EventType.CONFIGURE,
         connect.EventType.SYNCHRONIZE,
         connect.EventType.ACKNOWLEDGE,
         connect.EventType.LOG,
         connect.EventType.SERVER_BOUND_INTERNAL_LOG,
         connect.EventType.DOWNLOAD_LOG_FROM_CCP
      ];
   };

   Conduit.prototype.onUpstream = function(eventName, f) {
      connect.assertNotNull(eventName, 'eventName');
      connect.assertNotNull(f, 'f');
      connect.assertTrue(connect.isFunction(f), 'f must be a function');
      return this.upstreamBus.subscribe(eventName, f);
   };

   Conduit.prototype.onAllUpstream = function(f) {
      connect.assertNotNull(f, 'f');
      connect.assertTrue(connect.isFunction(f), 'f must be a function');
      return this.upstreamBus.subscribeAll(f);
   };

   Conduit.prototype.onDownstream = function(eventName, f) {
      connect.assertNotNull(eventName, 'eventName');
      connect.assertNotNull(f, 'f');
      connect.assertTrue(connect.isFunction(f), 'f must be a function');
      return this.downstreamBus.subscribe(eventName, f);
   };

   Conduit.prototype.onAllDownstream = function(f) {
      connect.assertNotNull(f, 'f');
      connect.assertTrue(connect.isFunction(f), 'f must be a function');
      return this.downstreamBus.subscribeAll(f);
   };

   Conduit.prototype.sendUpstream = function(eventName, data) {
      connect.assertNotNull(eventName, 'eventName');
      this.upstream.send({event: eventName, data: data});
   };

   Conduit.prototype.sendDownstream = function(eventName, data) {
      connect.assertNotNull(eventName, 'eventName');
      this.downstream.send({event: eventName, data: data});
   };

   Conduit.prototype._dispatchEvent = function(bus, messageEvent) {
      var message = messageEvent.data;
      if (message.event) {
         bus.trigger(message.event, message.data);
      }
   };

   /**
    * Returns a closure which passes events upstream.
    *
    * Usage:
    * conduit.onDownstream("MyEvent", conduit.passUpstream());
    */
   Conduit.prototype.passUpstream = function() {
      var self = this;
      return function(data, eventName) {
         if (!self.active && !self.allowedEvents.includes(eventName)){
            connect.getLog().debug(`[GR] Conduit ${self.name} has blocked event ${eventName} from going upstream.`).sendInternalLogToServer();
            return;
         }
         self.upstream.send({event: eventName, data: data});
      };
   };

   /**
    * Returns a closure which passes events downstream.
    *
    * Usage:
    * conduit.onUpstream("MyEvent", conduit.passDownstream());
    */
   Conduit.prototype.passDownstream = function() {
      var self = this;
      return function(data, eventName) {
         if (!self.active && !self.allowedEvents.includes(eventName)){
            connect.getLog().debug(`[GR] Conduit ${self.name} has blocked event ${eventName} from going downstream.`).sendInternalLogToServer();
            return;
         }
         self.downstream.send({event: eventName, data: data});
      };
   };

   /**
    * Shutdown the conduit's event busses and remove all subscriptions.
    */
   Conduit.prototype.shutdown = function() {
      this.upstreamBus.unsubscribeAll();
      this.downstreamBus.unsubscribeAll();
   };

   Conduit.prototype.setActive = function() {
      connect.getLog().info(`[GR] Setting CCP conduit as active`);

      this.active = true;
   };

   Conduit.prototype.setInactive = function() {
      connect.getLog().info(`[GR] Setting CCP conduit as inactive`);

      this.active = false;
   };

   /**---------------------------------------------------------------
    * class IFrameConduit extends Conduit
    *
    * Creates a conduit for the given IFrame element.
    */
   var IFrameConduit = function(name, window, iframe, domain) {
      Conduit.call(this, name, new WindowIOStream(window, iframe.contentWindow, domain || '*'), null);
   };
   IFrameConduit.prototype = Object.create(Conduit.prototype);
   IFrameConduit.prototype.constructor = IFrameConduit;

   class GRProxyIframeConduit {
      constructor(window, iframes, defaultActiveCCPUrl) {
         const defaultActiveOrigin = (new URL(defaultActiveCCPUrl)).origin;

         this.activeRegionUrl = defaultActiveOrigin;
         this.conduits = iframes.map((iframe) => {
            const iframeConduit = new IFrameConduit(iframe.src, window, iframe);
            iframeConduit.iframe = iframe;

            const { origin } = new URL(iframe.src);
            iframeConduit.name = origin;
            return iframeConduit;
         });
         this.setActiveConduit(defaultActiveOrigin);
      }
      
      onUpstream(eventName, f) {
         const subs = this.conduits.map((conduit) => {
            return conduit.onUpstream(eventName, f);
         });
         return {
            unsubscribe: () => subs.forEach((sub) => sub.unsubscribe()),
         };
      }

      onAllUpstream(f) {
         const subs = this.conduits.map((conduit) => {
            return conduit.onAllUpstream(f);
         });
         return {
            unsubscribe: () => subs.forEach((sub) => sub.unsubscribe()),
         };
      }

      onDownstream(eventName, f) {
         const subs = this.conduits.map((conduit) => {
            return conduit.onDownstream(eventName, f);
         });
         return {
            unsubscribe: () => subs.forEach((sub) => sub.unsubscribe()),
         };
      }
    
      onAllDownstream(f) {
         const subs = this.conduits.map((conduit) => {
            return conduit.onAllDownstream(f);
         });
         return {
            unsubscribe: () => subs.forEach((sub) => sub.unsubscribe()),
         };
      }

      sendUpstream(eventName, data) {
         this.conduits.forEach((conduit) => {
            conduit.sendUpstream(eventName, data);
         });
      }
    
      sendDownstream(eventName, data) {
         this.conduits.forEach((conduit) => {
            conduit.sendDownstream(eventName, data);
         });
      }

      // Relay an event from one shared worker to another
      relayUpstream(eventName){
         var self = this;

         this.conduits.forEach((conduit) => {
            conduit.onUpstream(eventName, function (data) {
               const otherConduit = self.getOtherConduit(conduit);
               otherConduit.sendUpstream(eventName, data);

               connect
                  .getLog()
                  .info(`Relayed event ${eventName} from ${conduit.name} to ${otherConduit.name} shared worker`)
                  .withObject({data})
                  .sendInternalLogToServer();
            })
         });
      }

      getAllConduits() {
         return this.conduits;
      }

      setActiveConduit(activeRegionUrl) {
         const newActiveConduit = this.conduits.find((conduit) => conduit.name === activeRegionUrl);
         if (!newActiveConduit) {
            connect.getLog().error(`[GR] No conduit found with the given ccpUrl: ${activeRegionUrl}`).sendInternalLogToServer();
            return;
         }

         this.conduits.forEach((conduit) => {
            if (conduit.name === activeRegionUrl) {
               this.activeRegionUrl = activeRegionUrl;

               // Update member variables in case customer directly referencing those  
               this.name = conduit.name;
               this.upstream = conduit.upstream;
               this.downstream = conduit.downstream;
               this.upstreamBus = conduit.upstreamBus;
               this.downstreamBus = conduit.downstreamBus;
            }
         });

         connect.getLog().info(`[GR] Switched to active conduit ${this.getActiveConduit().name}`).sendInternalLogToServer();
      }

      getActiveConduit() {
         return this.conduits.find((conduit) => conduit.name === this.activeRegionUrl);
      }

      getInactiveConduit() {
         return this.conduits.find((conduit) => conduit.name !== this.activeRegionUrl);
      }

      getOtherConduit(conduit) {
         return this.conduits.find((otherConduit) => conduit.name !== otherConduit.name);
      }
      
      getConduitByRegion(region) {
         return this.conduits.find((conduit) => conduit.region === region);
      }

      getConduitByName(name) {
         return this.conduits.find((conduit) => conduit.name === name);
      }
   }

   connect.Stream = Stream;
   connect.NullStream = NullStream;
   connect.WindowStream = WindowStream;
   connect.WindowIOStream = WindowIOStream;
   connect.PortStream = PortStream;
   connect.StreamMultiplexer = StreamMultiplexer;
   connect.Conduit = Conduit;
   connect.IFrameConduit = IFrameConduit;
   connect.GRProxyIframeConduit = GRProxyIframeConduit;
})();
