'use strict';

var require$$1 = require('lodash');
var require$$0 = require('algo_wasm_priorityqueue');

function _interopDefaultLegacy (e) { return e && typeof e === 'object' && 'default' in e ? e : { 'default': e }; }

var require$$1__default = /*#__PURE__*/_interopDefaultLegacy(require$$1);
var require$$0__default = /*#__PURE__*/_interopDefaultLegacy(require$$0);

var commonjsGlobal = typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : typeof self !== 'undefined' ? self : {};

function getAugmentedNamespace(n) {
  var f = n.default;
	if (typeof f == "function") {
		var a = function () {
			return f.apply(this, arguments);
		};
		a.prototype = f.prototype;
  } else a = {};
  Object.defineProperty(a, '__esModule', {value: true});
	Object.keys(n).forEach(function (k) {
		var d = Object.getOwnPropertyDescriptor(n, k);
		Object.defineProperty(a, k, d.get ? d : {
			enumerable: true,
			get: function () {
				return n[k];
			}
		});
	});
	return a;
}

let usedOnStart = 0;
let enabled = false;
let depth = 0;
let parentFn = '(tick)';

class ProfilerError extends Error {}

// Hack to ensure the InterShardMemory constant exists in sim
try {
  // eslint-disable-next-line no-unused-expressions
  InterShardMemory;
} catch (e) {
  commonjsGlobal.InterShardMemory = undefined;
}

function setupProfiler() {
  depth = 0; // reset depth, this needs to be done each tick.
  parentFn = '(tick)';
  Game.profiler = {
    stream(duration, filter) {
      setupMemory('stream', duration || 10, filter);
    },
    email(duration, filter) {
      setupMemory('email', duration || 100, filter);
    },
    profile(duration, filter) {
      setupMemory('profile', duration || 100, filter);
    },
    background(filter) {
      setupMemory('background', false, filter);
    },
    callgrind(duration, filter) {
      setupMemory('callgrind', duration || 100, filter);
    },
    restart() {
      if (Profiler.isProfiling()) {
        const filter = Memory.profiler.filter;
        let duration = false;
        if (!!Memory.profiler.disableTick) {
          // Calculate the original duration, profile is enabled on the tick after the first call,
          // so add 1.
          duration = Memory.profiler.disableTick - Memory.profiler.enabledTick + 1;
        }
        const type = Memory.profiler.type;
        setupMemory(type, duration, filter);
      }
    },
    reset: resetMemory,
    output: Profiler.output,
    downloadCallgrind: Profiler.downloadCallgrind,
  };

  overloadCPUCalc();
}

function setupMemory(profileType, duration, filter) {
  resetMemory();
  const disableTick = Number.isInteger(duration) ? Game.time + duration : false;
  if (!Memory.profiler) {
    Memory.profiler = {
      map: {},
      totalTime: 0,
      enabledTick: Game.time + 1,
      disableTick,
      type: profileType,
      filter,
    };
  }
  console.log(`Profiling type ${profileType} started at ${Game.time + 1} for ${duration} ticks`);
}

function resetMemory() {
  Memory.profiler = null;
}

function overloadCPUCalc() {
  if (Game.rooms.sim) {
    usedOnStart = 0; // This needs to be reset, but only in the sim.
    Game.cpu.getUsed = function getUsed() {
      return performance.now() - usedOnStart;
    };
  }
}

function getFilter() {
  return Memory.profiler.filter;
}

const functionBlackList = [
  'getUsed', // Let's avoid wrapping this... may lead to recursion issues and should be inexpensive.
  'constructor', // es6 class constructors need to be called with `new`
];

const commonProperties = ['length', 'name', 'arguments', 'caller', 'prototype'];

function wrapFunction(name, originalFunction) {
  // wrappedFunction.__profiler = Profiler;

  if (originalFunction.__profiler) {
    // eslint-disable-next-line no-param-reassign
    originalFunction.__profiler = Profiler;
    return originalFunction;
  }

  function wrappedFunction() {
    const profiler = wrappedFunction.__profiler;
    if (profiler.isProfiling()) {
      const nameMatchesFilter = name === getFilter();
      const start = Game.cpu.getUsed();
      if (nameMatchesFilter) {
        depth++;
      }
      const curParent = parentFn;
      parentFn = name;
      let result;
      if (this && this.constructor === wrappedFunction) {
        // eslint-disable-next-line new-cap
        result = new originalFunction(...arguments);
      } else {
        result = originalFunction.apply(this, arguments);
      }
      parentFn = curParent;
      if (depth > 0 || !getFilter()) {
        const end = Game.cpu.getUsed();
        profiler.record(name, end - start, parentFn);
      }
      if (nameMatchesFilter) {
        depth--;
      }
      return result;
    }

    if (this && this.constructor === wrappedFunction) {
      // eslint-disable-next-line new-cap
      return new originalFunction(...arguments);
    }
    return originalFunction.apply(this, arguments);
  }

  wrappedFunction.__profiler = Profiler;
  wrappedFunction.toString = () =>
    `// screeps-profiler wrapped function:\n${originalFunction.toString()}`;

  Object.getOwnPropertyNames(originalFunction).forEach(property => {
    if (!commonProperties.includes(property)) {
      wrappedFunction[property] = originalFunction[property];
    }
  });

  return wrappedFunction;
}

function hookUpPrototypes() {
  for (const { name, val } of Profiler.prototypes) {
    if (!val) {
      console.log(`skipping prototype hook ${name}, object appears to be missing`);
      continue;
    }
    profileObjectFunctions(val, name);
  }
}

function profileObjectFunctions(object, label) {
  if (!object || !(typeof object === 'object' || typeof object === 'function')) {
    throw new ProfilerError(`Asked to profile non-object ${object} for ${label}
     (${typeof object})`);
  }

  if (object.prototype) {
    profileObjectFunctions(object.prototype, label);
  }
  const objectToWrap = object;

  Object.getOwnPropertyNames(objectToWrap).forEach(functionName => {
    const extendedLabel = `${label}.${functionName}`;

    const isBlackListed = functionBlackList.indexOf(functionName) !== -1;
    if (isBlackListed) {
      return;
    }

    const descriptor = Object.getOwnPropertyDescriptor(objectToWrap, functionName);
    if (!descriptor) {
      return;
    }

    const hasAccessor = descriptor.get || descriptor.set;
    if (hasAccessor) {
      const configurable = descriptor.configurable;
      if (!configurable) {
        return;
      }

      const profileDescriptor = {};

      if (descriptor.get) {
        const extendedLabelGet = `${extendedLabel}:get`;
        profileDescriptor.get = profileFunction(descriptor.get, extendedLabelGet);
      }

      if (descriptor.set) {
        const extendedLabelSet = `${extendedLabel}:set`;
        profileDescriptor.set = profileFunction(descriptor.set, extendedLabelSet);
      }

      Object.defineProperty(objectToWrap, functionName, profileDescriptor);
      return;
    }

    const isFunction = typeof descriptor.value === 'function';
    if (!isFunction || !descriptor.writable) {
      return;
    }
    const originalFunction = objectToWrap[functionName];
    objectToWrap[functionName] = profileFunction(originalFunction, extendedLabel);
  });

  return objectToWrap;
}

function profileFunction(fn, functionName) {
  const fnName = functionName || fn.name;
  if (!fnName) {
    console.log('Couldn\'t find a function name for - ', fn);
    console.log('Will not profile this function.');
    return fn;
  }

  return wrapFunction(fnName, fn);
}

const Profiler = {
  printProfile() {
    console.log(Profiler.output());
  },

  emailProfile() {
    Game.notify(Profiler.output(1000));
  },

  downloadCallgrind() {
    const id = `id${Math.random()}`;
    const shardId = Game.shard.name + (Game.shard.ptr ? '-ptr' : '');
    const filename = `callgrind.${shardId}.${Game.time}`;
    const data = Profiler.callgrind();
    if (!data) {
      console.log('No profile data to download');
      return;
    }
    /* eslint-disable */
    const download = `
    <script>
    var element = document.getElementById('${id}');
    if (!element) {
      element = document.createElement('a');
      element.setAttribute('id', '${id}');
      element.setAttribute('href', 'data:text/plain;charset=utf-8,${encodeURIComponent(data)}');
      element.setAttribute('download', '${filename}');

      element.style.display = 'none';
      document.body.appendChild(element);

      element.click();
    }
    </script>
    `;
    /* eslint-enable */
    console.log(
      download
      .split('\n')
      .map((s) => s.trim())
      .join('')
    );
  },

  callgrind() {
    if (!Memory.profiler || !Memory.profiler.enabledTick) return null;
    const elapsedTicks = Game.time - Memory.profiler.enabledTick + 1;
    Profiler.checkMapItem('(tick)');
    Memory.profiler.map['(tick)'].calls = elapsedTicks;
    Memory.profiler.map['(tick)'].time = Memory.profiler.totalTime;
    Profiler.checkMapItem('(root)');
    Memory.profiler.map['(root)'].calls = 1;
    Memory.profiler.map['(root)'].time = Memory.profiler.totalTime;
    Profiler.checkMapItem('(tick)', Memory.profiler.map['(root)'].subs);
    Memory.profiler.map['(root)'].subs['(tick)'].calls = elapsedTicks;
    Memory.profiler.map['(root)'].subs['(tick)'].time = Memory.profiler.totalTime;
    let body = `events: ns\nsummary: ${Math.round(
      Memory.profiler.totalTime * 1000000
      )}\n`;
    for (const fnName of Object.keys(Memory.profiler.map)) {
      const fn = Memory.profiler.map[fnName];
      let callsBody = '';
      let callsTime = 0;
      for (const callName of Object.keys(fn.subs)) {
        const call = fn.subs[callName];
        const ns = Math.round(call.time * 1000000);
        callsBody += `cfn=${callName}\ncalls=${call.calls} 1\n1 ${ns}\n`;
        callsTime += call.time;
      }
      body += `\nfn=${fnName}\n1 ${Math.round(
        (fn.time - callsTime) * 1000000
        )}\n${callsBody}`;
    }
    return body;
  },

  output(passedOutputLengthLimit) {
    const outputLengthLimit = passedOutputLengthLimit || 1000;
    if (!Memory.profiler || !Memory.profiler.enabledTick) {
      return 'Profiler not active.';
    }

    const endTick = Math.min(Memory.profiler.disableTick || Game.time, Game.time);
    const startTick = Memory.profiler.enabledTick;
    const elapsedTicks = endTick - startTick + 1;
    const header = 'calls\t\ttime\t\tavg\t\tfunction';
    const footer = [
      `Avg: ${(Memory.profiler.totalTime / elapsedTicks).toFixed(2)}`,
      `Total: ${Memory.profiler.totalTime.toFixed(2)}`,
      `Ticks: ${elapsedTicks}`,
    ].join('\t');

    const lines = [header];
    let currentLength = header.length + 1 + footer.length;
    const allLines = Profiler.lines();
    let done = false;
    while (!done && allLines.length) {
      const line = allLines.shift();
      // each line added adds the line length plus a new line character.
      if (currentLength + line.length + 1 < outputLengthLimit) {
        lines.push(line);
        currentLength += line.length + 1;
      } else {
        done = true;
      }
    }
    lines.push(footer);
    return lines.join('\n');
  },

  lines() {
    const stats = Object.keys(Memory.profiler.map).map(functionName => {
      const functionCalls = Memory.profiler.map[functionName];
      return {
        name: functionName,
        calls: functionCalls.calls,
        totalTime: functionCalls.time,
        averageTime: functionCalls.time / functionCalls.calls,
      };
    }).sort((val1, val2) => {
      return val2.totalTime - val1.totalTime;
    });

    const lines = stats.map(data => {
      return [
        data.calls,
        data.totalTime.toFixed(1),
        data.averageTime.toFixed(3),
        data.name,
      ].join('\t\t');
    });

    return lines;
  },

  prototypes: [
    { name: 'ConstructionSite', val: ConstructionSite },
    { name: 'Creep', val: Creep },
    { name: 'Deposit', val: Deposit },
    { name: 'Flag', val: Flag },
    { name: 'Game', val: Game },
    { name: 'InterShardMemory', val: InterShardMemory },
    { name: 'Mineral', val: Mineral },
    { name: 'Nuke', val: Nuke },
    { name: 'OwnedStructure', val: OwnedStructure },
    { name: 'PathFinder', val: PathFinder },
    { name: 'PowerCreep', val: PowerCreep },
    { name: 'RawMemory', val: RawMemory },
    { name: 'Resource', val: Resource },
    { name: 'Room', val: Room },
    { name: 'RoomObject', val: RoomObject },
    { name: 'RoomPosition', val: RoomPosition },
    { name: 'RoomVisual', val: RoomVisual },
    { name: 'Ruin', val: Ruin },
    { name: 'Source', val: Source },
    { name: 'Store', val: Store },
    { name: 'Structure', val: Structure },
    { name: 'StructureContainer', val: StructureContainer },
    { name: 'StructureController', val: StructureController },
    { name: 'StructureExtension', val: StructureExtension },
    { name: 'StructureExtractor', val: StructureExtractor },
    { name: 'StructureFactory', val: StructureFactory },
    { name: 'StructureInvaderCore', val: StructureInvaderCore },
    { name: 'StructureKeeperLair', val: StructureKeeperLair },
    { name: 'StructureLab', val: StructureLab },
    { name: 'StructureLink', val: StructureLink },
    { name: 'StructureNuker', val: StructureNuker },
    { name: 'StructureObserver', val: StructureObserver },
    { name: 'StructurePortal', val: StructurePortal },
    { name: 'StructurePowerBank', val: StructurePowerBank },
    { name: 'StructurePowerSpawn', val: StructurePowerSpawn },
    { name: 'StructureRampart', val: StructureRampart },
    { name: 'StructureRoad', val: StructureRoad },
    { name: 'StructureSpawn', val: StructureSpawn },
    { name: 'StructureStorage', val: StructureStorage },
    { name: 'StructureTerminal', val: StructureTerminal },
    { name: 'StructureTower', val: StructureTower },
    { name: 'StructureWall', val: StructureWall },
    { name: 'Tombstone', val: Tombstone },
  ],

  checkMapItem(functionName, map = Memory.profiler.map) {
    if (!map[functionName]) {
      // eslint-disable-next-line no-param-reassign
      map[functionName] = {
        time: 0,
        calls: 0,
        subs: {},
      };
    }
  },

  record(functionName, time, parent) {
    this.checkMapItem(functionName);
    Memory.profiler.map[functionName].calls++;
    Memory.profiler.map[functionName].time += time;
    if (parent) {
      this.checkMapItem(parent);
      this.checkMapItem(functionName, Memory.profiler.map[parent].subs);
      Memory.profiler.map[parent].subs[functionName].calls++;
      Memory.profiler.map[parent].subs[functionName].time += time;
    }
  },

  endTick() {
    if (Game.time >= Memory.profiler.enabledTick) {
      const cpuUsed = Game.cpu.getUsed();
      Memory.profiler.totalTime += cpuUsed;
      Profiler.report();
    }
  },

  report() {
    if (Profiler.shouldPrint()) {
      Profiler.printProfile();
    } else if (Profiler.shouldEmail()) {
      Profiler.emailProfile();
    } else if (Profiler.shouldCallgrind()) {
      Profiler.downloadCallgrind();
    }
  },

  isProfiling() {
    if (!enabled || !Memory.profiler) {
      return false;
    }
    return !Memory.profiler.disableTick || Game.time <= Memory.profiler.disableTick;
  },

  type() {
    return Memory.profiler.type;
  },

  shouldPrint() {
    const streaming = Profiler.type() === 'stream';
    const profiling = Profiler.type() === 'profile';
    const onEndingTick = Memory.profiler.disableTick === Game.time;
    return streaming || (profiling && onEndingTick);
  },

  shouldEmail() {
    return Profiler.type() === 'email' && Memory.profiler.disableTick === Game.time;
  },

  shouldCallgrind() {
    return (
      Profiler.type() === 'callgrind' &&
      Memory.profiler.disableTick === Game.time
    );
  },
};

var screepsProfiler = {
  wrap(callback) {
    if (enabled) {
      setupProfiler();
    }

    if (Profiler.isProfiling()) {
      usedOnStart = Game.cpu.getUsed();

      // Commented lines are part of an on going experiment to keep the profiler
      // performant, and measure certain types of overhead.

      // var callbackStart = Game.cpu.getUsed();
      const returnVal = callback();
      // var callbackEnd = Game.cpu.getUsed();
      Profiler.endTick();
      // var end = Game.cpu.getUsed();

      // var profilerTime = (end - start) - (callbackEnd - callbackStart);
      // var callbackTime = callbackEnd - callbackStart;
      // var unaccounted = end - profilerTime - callbackTime;
      // console.log('total-', end, 'profiler-', profilerTime, 'callbacktime-',
      // callbackTime, 'start-', start, 'unaccounted', unaccounted);
      return returnVal;
    }

    return callback();
  },

  enable() {
    enabled = true;
    hookUpPrototypes();
  },

  output: Profiler.output,
  callgrind: Profiler.callgrind,

  registerObject: profileObjectFunctions,
  registerFN: profileFunction,
  registerClass: profileObjectFunctions,

  Error: ProfilerError,
};

var sourceMapGenerator = {};

var base64Vlq = {};

var base64$1 = {};

/* -*- Mode: js; js-indent-level: 2; -*- */

/*
 * Copyright 2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */

var intToCharMap = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('');

/**
 * Encode an integer in the range of 0 to 63 to a single base 64 digit.
 */
base64$1.encode = function (number) {
  if (0 <= number && number < intToCharMap.length) {
    return intToCharMap[number];
  }
  throw new TypeError("Must be between 0 and 63: " + number);
};

/**
 * Decode a single base 64 character code digit to an integer. Returns -1 on
 * failure.
 */
base64$1.decode = function (charCode) {
  var bigA = 65;     // 'A'
  var bigZ = 90;     // 'Z'

  var littleA = 97;  // 'a'
  var littleZ = 122; // 'z'

  var zero = 48;     // '0'
  var nine = 57;     // '9'

  var plus = 43;     // '+'
  var slash = 47;    // '/'

  var littleOffset = 26;
  var numberOffset = 52;

  // 0 - 25: ABCDEFGHIJKLMNOPQRSTUVWXYZ
  if (bigA <= charCode && charCode <= bigZ) {
    return (charCode - bigA);
  }

  // 26 - 51: abcdefghijklmnopqrstuvwxyz
  if (littleA <= charCode && charCode <= littleZ) {
    return (charCode - littleA + littleOffset);
  }

  // 52 - 61: 0123456789
  if (zero <= charCode && charCode <= nine) {
    return (charCode - zero + numberOffset);
  }

  // 62: +
  if (charCode == plus) {
    return 62;
  }

  // 63: /
  if (charCode == slash) {
    return 63;
  }

  // Invalid base64 digit.
  return -1;
};

/* -*- Mode: js; js-indent-level: 2; -*- */

/*
 * Copyright 2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 *
 * Based on the Base 64 VLQ implementation in Closure Compiler:
 * https://code.google.com/p/closure-compiler/source/browse/trunk/src/com/google/debugging/sourcemap/Base64VLQ.java
 *
 * Copyright 2011 The Closure Compiler Authors. All rights reserved.
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 *  * Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above
 *    copyright notice, this list of conditions and the following
 *    disclaimer in the documentation and/or other materials provided
 *    with the distribution.
 *  * Neither the name of Google Inc. nor the names of its
 *    contributors may be used to endorse or promote products derived
 *    from this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

var base64 = base64$1;

// A single base 64 digit can contain 6 bits of data. For the base 64 variable
// length quantities we use in the source map spec, the first bit is the sign,
// the next four bits are the actual value, and the 6th bit is the
// continuation bit. The continuation bit tells us whether there are more
// digits in this value following this digit.
//
//   Continuation
//   |    Sign
//   |    |
//   V    V
//   101011

var VLQ_BASE_SHIFT = 5;

// binary: 100000
var VLQ_BASE = 1 << VLQ_BASE_SHIFT;

// binary: 011111
var VLQ_BASE_MASK = VLQ_BASE - 1;

// binary: 100000
var VLQ_CONTINUATION_BIT = VLQ_BASE;

/**
 * Converts from a two-complement value to a value where the sign bit is
 * placed in the least significant bit.  For example, as decimals:
 *   1 becomes 2 (10 binary), -1 becomes 3 (11 binary)
 *   2 becomes 4 (100 binary), -2 becomes 5 (101 binary)
 */
function toVLQSigned(aValue) {
  return aValue < 0
    ? ((-aValue) << 1) + 1
    : (aValue << 1) + 0;
}

/**
 * Converts to a two-complement value from a value where the sign bit is
 * placed in the least significant bit.  For example, as decimals:
 *   2 (10 binary) becomes 1, 3 (11 binary) becomes -1
 *   4 (100 binary) becomes 2, 5 (101 binary) becomes -2
 */
function fromVLQSigned(aValue) {
  var isNegative = (aValue & 1) === 1;
  var shifted = aValue >> 1;
  return isNegative
    ? -shifted
    : shifted;
}

/**
 * Returns the base 64 VLQ encoded value.
 */
base64Vlq.encode = function base64VLQ_encode(aValue) {
  var encoded = "";
  var digit;

  var vlq = toVLQSigned(aValue);

  do {
    digit = vlq & VLQ_BASE_MASK;
    vlq >>>= VLQ_BASE_SHIFT;
    if (vlq > 0) {
      // There are still more digits in this value, so we must make sure the
      // continuation bit is marked.
      digit |= VLQ_CONTINUATION_BIT;
    }
    encoded += base64.encode(digit);
  } while (vlq > 0);

  return encoded;
};

/**
 * Decodes the next base 64 VLQ value from the given string and returns the
 * value and the rest of the string via the out parameter.
 */
base64Vlq.decode = function base64VLQ_decode(aStr, aIndex, aOutParam) {
  var strLen = aStr.length;
  var result = 0;
  var shift = 0;
  var continuation, digit;

  do {
    if (aIndex >= strLen) {
      throw new Error("Expected more digits in base 64 VLQ value.");
    }

    digit = base64.decode(aStr.charCodeAt(aIndex++));
    if (digit === -1) {
      throw new Error("Invalid base64 digit: " + aStr.charAt(aIndex - 1));
    }

    continuation = !!(digit & VLQ_CONTINUATION_BIT);
    digit &= VLQ_BASE_MASK;
    result = result + (digit << shift);
    shift += VLQ_BASE_SHIFT;
  } while (continuation);

  aOutParam.value = fromVLQSigned(result);
  aOutParam.rest = aIndex;
};

var util$5 = {};

/* -*- Mode: js; js-indent-level: 2; -*- */

(function (exports) {
	/*
	 * Copyright 2011 Mozilla Foundation and contributors
	 * Licensed under the New BSD license. See LICENSE or:
	 * http://opensource.org/licenses/BSD-3-Clause
	 */

	/**
	 * This is a helper function for getting values from parameter/options
	 * objects.
	 *
	 * @param args The object we are extracting values from
	 * @param name The name of the property we are getting.
	 * @param defaultValue An optional value to return if the property is missing
	 * from the object. If this is not specified and the property is missing, an
	 * error will be thrown.
	 */
	function getArg(aArgs, aName, aDefaultValue) {
	  if (aName in aArgs) {
	    return aArgs[aName];
	  } else if (arguments.length === 3) {
	    return aDefaultValue;
	  } else {
	    throw new Error('"' + aName + '" is a required argument.');
	  }
	}
	exports.getArg = getArg;

	var urlRegexp = /^(?:([\w+\-.]+):)?\/\/(?:(\w+:\w+)@)?([\w.-]*)(?::(\d+))?(.*)$/;
	var dataUrlRegexp = /^data:.+\,.+$/;

	function urlParse(aUrl) {
	  var match = aUrl.match(urlRegexp);
	  if (!match) {
	    return null;
	  }
	  return {
	    scheme: match[1],
	    auth: match[2],
	    host: match[3],
	    port: match[4],
	    path: match[5]
	  };
	}
	exports.urlParse = urlParse;

	function urlGenerate(aParsedUrl) {
	  var url = '';
	  if (aParsedUrl.scheme) {
	    url += aParsedUrl.scheme + ':';
	  }
	  url += '//';
	  if (aParsedUrl.auth) {
	    url += aParsedUrl.auth + '@';
	  }
	  if (aParsedUrl.host) {
	    url += aParsedUrl.host;
	  }
	  if (aParsedUrl.port) {
	    url += ":" + aParsedUrl.port;
	  }
	  if (aParsedUrl.path) {
	    url += aParsedUrl.path;
	  }
	  return url;
	}
	exports.urlGenerate = urlGenerate;

	/**
	 * Normalizes a path, or the path portion of a URL:
	 *
	 * - Replaces consecutive slashes with one slash.
	 * - Removes unnecessary '.' parts.
	 * - Removes unnecessary '<dir>/..' parts.
	 *
	 * Based on code in the Node.js 'path' core module.
	 *
	 * @param aPath The path or url to normalize.
	 */
	function normalize(aPath) {
	  var path = aPath;
	  var url = urlParse(aPath);
	  if (url) {
	    if (!url.path) {
	      return aPath;
	    }
	    path = url.path;
	  }
	  var isAbsolute = exports.isAbsolute(path);

	  var parts = path.split(/\/+/);
	  for (var part, up = 0, i = parts.length - 1; i >= 0; i--) {
	    part = parts[i];
	    if (part === '.') {
	      parts.splice(i, 1);
	    } else if (part === '..') {
	      up++;
	    } else if (up > 0) {
	      if (part === '') {
	        // The first part is blank if the path is absolute. Trying to go
	        // above the root is a no-op. Therefore we can remove all '..' parts
	        // directly after the root.
	        parts.splice(i + 1, up);
	        up = 0;
	      } else {
	        parts.splice(i, 2);
	        up--;
	      }
	    }
	  }
	  path = parts.join('/');

	  if (path === '') {
	    path = isAbsolute ? '/' : '.';
	  }

	  if (url) {
	    url.path = path;
	    return urlGenerate(url);
	  }
	  return path;
	}
	exports.normalize = normalize;

	/**
	 * Joins two paths/URLs.
	 *
	 * @param aRoot The root path or URL.
	 * @param aPath The path or URL to be joined with the root.
	 *
	 * - If aPath is a URL or a data URI, aPath is returned, unless aPath is a
	 *   scheme-relative URL: Then the scheme of aRoot, if any, is prepended
	 *   first.
	 * - Otherwise aPath is a path. If aRoot is a URL, then its path portion
	 *   is updated with the result and aRoot is returned. Otherwise the result
	 *   is returned.
	 *   - If aPath is absolute, the result is aPath.
	 *   - Otherwise the two paths are joined with a slash.
	 * - Joining for example 'http://' and 'www.example.com' is also supported.
	 */
	function join(aRoot, aPath) {
	  if (aRoot === "") {
	    aRoot = ".";
	  }
	  if (aPath === "") {
	    aPath = ".";
	  }
	  var aPathUrl = urlParse(aPath);
	  var aRootUrl = urlParse(aRoot);
	  if (aRootUrl) {
	    aRoot = aRootUrl.path || '/';
	  }

	  // `join(foo, '//www.example.org')`
	  if (aPathUrl && !aPathUrl.scheme) {
	    if (aRootUrl) {
	      aPathUrl.scheme = aRootUrl.scheme;
	    }
	    return urlGenerate(aPathUrl);
	  }

	  if (aPathUrl || aPath.match(dataUrlRegexp)) {
	    return aPath;
	  }

	  // `join('http://', 'www.example.com')`
	  if (aRootUrl && !aRootUrl.host && !aRootUrl.path) {
	    aRootUrl.host = aPath;
	    return urlGenerate(aRootUrl);
	  }

	  var joined = aPath.charAt(0) === '/'
	    ? aPath
	    : normalize(aRoot.replace(/\/+$/, '') + '/' + aPath);

	  if (aRootUrl) {
	    aRootUrl.path = joined;
	    return urlGenerate(aRootUrl);
	  }
	  return joined;
	}
	exports.join = join;

	exports.isAbsolute = function (aPath) {
	  return aPath.charAt(0) === '/' || urlRegexp.test(aPath);
	};

	/**
	 * Make a path relative to a URL or another path.
	 *
	 * @param aRoot The root path or URL.
	 * @param aPath The path or URL to be made relative to aRoot.
	 */
	function relative(aRoot, aPath) {
	  if (aRoot === "") {
	    aRoot = ".";
	  }

	  aRoot = aRoot.replace(/\/$/, '');

	  // It is possible for the path to be above the root. In this case, simply
	  // checking whether the root is a prefix of the path won't work. Instead, we
	  // need to remove components from the root one by one, until either we find
	  // a prefix that fits, or we run out of components to remove.
	  var level = 0;
	  while (aPath.indexOf(aRoot + '/') !== 0) {
	    var index = aRoot.lastIndexOf("/");
	    if (index < 0) {
	      return aPath;
	    }

	    // If the only part of the root that is left is the scheme (i.e. http://,
	    // file:///, etc.), one or more slashes (/), or simply nothing at all, we
	    // have exhausted all components, so the path is not relative to the root.
	    aRoot = aRoot.slice(0, index);
	    if (aRoot.match(/^([^\/]+:\/)?\/*$/)) {
	      return aPath;
	    }

	    ++level;
	  }

	  // Make sure we add a "../" for each component we removed from the root.
	  return Array(level + 1).join("../") + aPath.substr(aRoot.length + 1);
	}
	exports.relative = relative;

	var supportsNullProto = (function () {
	  var obj = Object.create(null);
	  return !('__proto__' in obj);
	}());

	function identity (s) {
	  return s;
	}

	/**
	 * Because behavior goes wacky when you set `__proto__` on objects, we
	 * have to prefix all the strings in our set with an arbitrary character.
	 *
	 * See https://github.com/mozilla/source-map/pull/31 and
	 * https://github.com/mozilla/source-map/issues/30
	 *
	 * @param String aStr
	 */
	function toSetString(aStr) {
	  if (isProtoString(aStr)) {
	    return '$' + aStr;
	  }

	  return aStr;
	}
	exports.toSetString = supportsNullProto ? identity : toSetString;

	function fromSetString(aStr) {
	  if (isProtoString(aStr)) {
	    return aStr.slice(1);
	  }

	  return aStr;
	}
	exports.fromSetString = supportsNullProto ? identity : fromSetString;

	function isProtoString(s) {
	  if (!s) {
	    return false;
	  }

	  var length = s.length;

	  if (length < 9 /* "__proto__".length */) {
	    return false;
	  }

	  if (s.charCodeAt(length - 1) !== 95  /* '_' */ ||
	      s.charCodeAt(length - 2) !== 95  /* '_' */ ||
	      s.charCodeAt(length - 3) !== 111 /* 'o' */ ||
	      s.charCodeAt(length - 4) !== 116 /* 't' */ ||
	      s.charCodeAt(length - 5) !== 111 /* 'o' */ ||
	      s.charCodeAt(length - 6) !== 114 /* 'r' */ ||
	      s.charCodeAt(length - 7) !== 112 /* 'p' */ ||
	      s.charCodeAt(length - 8) !== 95  /* '_' */ ||
	      s.charCodeAt(length - 9) !== 95  /* '_' */) {
	    return false;
	  }

	  for (var i = length - 10; i >= 0; i--) {
	    if (s.charCodeAt(i) !== 36 /* '$' */) {
	      return false;
	    }
	  }

	  return true;
	}

	/**
	 * Comparator between two mappings where the original positions are compared.
	 *
	 * Optionally pass in `true` as `onlyCompareGenerated` to consider two
	 * mappings with the same original source/line/column, but different generated
	 * line and column the same. Useful when searching for a mapping with a
	 * stubbed out mapping.
	 */
	function compareByOriginalPositions(mappingA, mappingB, onlyCompareOriginal) {
	  var cmp = strcmp(mappingA.source, mappingB.source);
	  if (cmp !== 0) {
	    return cmp;
	  }

	  cmp = mappingA.originalLine - mappingB.originalLine;
	  if (cmp !== 0) {
	    return cmp;
	  }

	  cmp = mappingA.originalColumn - mappingB.originalColumn;
	  if (cmp !== 0 || onlyCompareOriginal) {
	    return cmp;
	  }

	  cmp = mappingA.generatedColumn - mappingB.generatedColumn;
	  if (cmp !== 0) {
	    return cmp;
	  }

	  cmp = mappingA.generatedLine - mappingB.generatedLine;
	  if (cmp !== 0) {
	    return cmp;
	  }

	  return strcmp(mappingA.name, mappingB.name);
	}
	exports.compareByOriginalPositions = compareByOriginalPositions;

	/**
	 * Comparator between two mappings with deflated source and name indices where
	 * the generated positions are compared.
	 *
	 * Optionally pass in `true` as `onlyCompareGenerated` to consider two
	 * mappings with the same generated line and column, but different
	 * source/name/original line and column the same. Useful when searching for a
	 * mapping with a stubbed out mapping.
	 */
	function compareByGeneratedPositionsDeflated(mappingA, mappingB, onlyCompareGenerated) {
	  var cmp = mappingA.generatedLine - mappingB.generatedLine;
	  if (cmp !== 0) {
	    return cmp;
	  }

	  cmp = mappingA.generatedColumn - mappingB.generatedColumn;
	  if (cmp !== 0 || onlyCompareGenerated) {
	    return cmp;
	  }

	  cmp = strcmp(mappingA.source, mappingB.source);
	  if (cmp !== 0) {
	    return cmp;
	  }

	  cmp = mappingA.originalLine - mappingB.originalLine;
	  if (cmp !== 0) {
	    return cmp;
	  }

	  cmp = mappingA.originalColumn - mappingB.originalColumn;
	  if (cmp !== 0) {
	    return cmp;
	  }

	  return strcmp(mappingA.name, mappingB.name);
	}
	exports.compareByGeneratedPositionsDeflated = compareByGeneratedPositionsDeflated;

	function strcmp(aStr1, aStr2) {
	  if (aStr1 === aStr2) {
	    return 0;
	  }

	  if (aStr1 === null) {
	    return 1; // aStr2 !== null
	  }

	  if (aStr2 === null) {
	    return -1; // aStr1 !== null
	  }

	  if (aStr1 > aStr2) {
	    return 1;
	  }

	  return -1;
	}

	/**
	 * Comparator between two mappings with inflated source and name strings where
	 * the generated positions are compared.
	 */
	function compareByGeneratedPositionsInflated(mappingA, mappingB) {
	  var cmp = mappingA.generatedLine - mappingB.generatedLine;
	  if (cmp !== 0) {
	    return cmp;
	  }

	  cmp = mappingA.generatedColumn - mappingB.generatedColumn;
	  if (cmp !== 0) {
	    return cmp;
	  }

	  cmp = strcmp(mappingA.source, mappingB.source);
	  if (cmp !== 0) {
	    return cmp;
	  }

	  cmp = mappingA.originalLine - mappingB.originalLine;
	  if (cmp !== 0) {
	    return cmp;
	  }

	  cmp = mappingA.originalColumn - mappingB.originalColumn;
	  if (cmp !== 0) {
	    return cmp;
	  }

	  return strcmp(mappingA.name, mappingB.name);
	}
	exports.compareByGeneratedPositionsInflated = compareByGeneratedPositionsInflated;

	/**
	 * Strip any JSON XSSI avoidance prefix from the string (as documented
	 * in the source maps specification), and then parse the string as
	 * JSON.
	 */
	function parseSourceMapInput(str) {
	  return JSON.parse(str.replace(/^\)]}'[^\n]*\n/, ''));
	}
	exports.parseSourceMapInput = parseSourceMapInput;

	/**
	 * Compute the URL of a source given the the source root, the source's
	 * URL, and the source map's URL.
	 */
	function computeSourceURL(sourceRoot, sourceURL, sourceMapURL) {
	  sourceURL = sourceURL || '';

	  if (sourceRoot) {
	    // This follows what Chrome does.
	    if (sourceRoot[sourceRoot.length - 1] !== '/' && sourceURL[0] !== '/') {
	      sourceRoot += '/';
	    }
	    // The spec says:
	    //   Line 4: An optional source root, useful for relocating source
	    //   files on a server or removing repeated values in the
	    //   “sources” entry.  This value is prepended to the individual
	    //   entries in the “source” field.
	    sourceURL = sourceRoot + sourceURL;
	  }

	  // Historically, SourceMapConsumer did not take the sourceMapURL as
	  // a parameter.  This mode is still somewhat supported, which is why
	  // this code block is conditional.  However, it's preferable to pass
	  // the source map URL to SourceMapConsumer, so that this function
	  // can implement the source URL resolution algorithm as outlined in
	  // the spec.  This block is basically the equivalent of:
	  //    new URL(sourceURL, sourceMapURL).toString()
	  // ... except it avoids using URL, which wasn't available in the
	  // older releases of node still supported by this library.
	  //
	  // The spec says:
	  //   If the sources are not absolute URLs after prepending of the
	  //   “sourceRoot”, the sources are resolved relative to the
	  //   SourceMap (like resolving script src in a html document).
	  if (sourceMapURL) {
	    var parsed = urlParse(sourceMapURL);
	    if (!parsed) {
	      throw new Error("sourceMapURL could not be parsed");
	    }
	    if (parsed.path) {
	      // Strip the last path component, but keep the "/".
	      var index = parsed.path.lastIndexOf('/');
	      if (index >= 0) {
	        parsed.path = parsed.path.substring(0, index + 1);
	      }
	    }
	    sourceURL = join(urlGenerate(parsed), sourceURL);
	  }

	  return normalize(sourceURL);
	}
	exports.computeSourceURL = computeSourceURL;
} (util$5));

var arraySet = {};

/* -*- Mode: js; js-indent-level: 2; -*- */

/*
 * Copyright 2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */

var util$4 = util$5;
var has = Object.prototype.hasOwnProperty;
var hasNativeMap = typeof Map !== "undefined";

/**
 * A data structure which is a combination of an array and a set. Adding a new
 * member is O(1), testing for membership is O(1), and finding the index of an
 * element is O(1). Removing elements from the set is not supported. Only
 * strings are supported for membership.
 */
function ArraySet$2() {
  this._array = [];
  this._set = hasNativeMap ? new Map() : Object.create(null);
}

/**
 * Static method for creating ArraySet instances from an existing array.
 */
ArraySet$2.fromArray = function ArraySet_fromArray(aArray, aAllowDuplicates) {
  var set = new ArraySet$2();
  for (var i = 0, len = aArray.length; i < len; i++) {
    set.add(aArray[i], aAllowDuplicates);
  }
  return set;
};

/**
 * Return how many unique items are in this ArraySet. If duplicates have been
 * added, than those do not count towards the size.
 *
 * @returns Number
 */
ArraySet$2.prototype.size = function ArraySet_size() {
  return hasNativeMap ? this._set.size : Object.getOwnPropertyNames(this._set).length;
};

/**
 * Add the given string to this set.
 *
 * @param String aStr
 */
ArraySet$2.prototype.add = function ArraySet_add(aStr, aAllowDuplicates) {
  var sStr = hasNativeMap ? aStr : util$4.toSetString(aStr);
  var isDuplicate = hasNativeMap ? this.has(aStr) : has.call(this._set, sStr);
  var idx = this._array.length;
  if (!isDuplicate || aAllowDuplicates) {
    this._array.push(aStr);
  }
  if (!isDuplicate) {
    if (hasNativeMap) {
      this._set.set(aStr, idx);
    } else {
      this._set[sStr] = idx;
    }
  }
};

/**
 * Is the given string a member of this set?
 *
 * @param String aStr
 */
ArraySet$2.prototype.has = function ArraySet_has(aStr) {
  if (hasNativeMap) {
    return this._set.has(aStr);
  } else {
    var sStr = util$4.toSetString(aStr);
    return has.call(this._set, sStr);
  }
};

/**
 * What is the index of the given string in the array?
 *
 * @param String aStr
 */
ArraySet$2.prototype.indexOf = function ArraySet_indexOf(aStr) {
  if (hasNativeMap) {
    var idx = this._set.get(aStr);
    if (idx >= 0) {
        return idx;
    }
  } else {
    var sStr = util$4.toSetString(aStr);
    if (has.call(this._set, sStr)) {
      return this._set[sStr];
    }
  }

  throw new Error('"' + aStr + '" is not in the set.');
};

/**
 * What is the element at the given index?
 *
 * @param Number aIdx
 */
ArraySet$2.prototype.at = function ArraySet_at(aIdx) {
  if (aIdx >= 0 && aIdx < this._array.length) {
    return this._array[aIdx];
  }
  throw new Error('No element indexed by ' + aIdx);
};

/**
 * Returns the array representation of this set (which has the proper indices
 * indicated by indexOf). Note that this is a copy of the internal array used
 * for storing the members so that no one can mess with internal state.
 */
ArraySet$2.prototype.toArray = function ArraySet_toArray() {
  return this._array.slice();
};

arraySet.ArraySet = ArraySet$2;

var mappingList = {};

/* -*- Mode: js; js-indent-level: 2; -*- */

/*
 * Copyright 2014 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */

var util$3 = util$5;

/**
 * Determine whether mappingB is after mappingA with respect to generated
 * position.
 */
function generatedPositionAfter(mappingA, mappingB) {
  // Optimized for most common case
  var lineA = mappingA.generatedLine;
  var lineB = mappingB.generatedLine;
  var columnA = mappingA.generatedColumn;
  var columnB = mappingB.generatedColumn;
  return lineB > lineA || lineB == lineA && columnB >= columnA ||
         util$3.compareByGeneratedPositionsInflated(mappingA, mappingB) <= 0;
}

/**
 * A data structure to provide a sorted view of accumulated mappings in a
 * performance conscious manner. It trades a neglibable overhead in general
 * case for a large speedup in case of mappings being added in order.
 */
function MappingList$1() {
  this._array = [];
  this._sorted = true;
  // Serves as infimum
  this._last = {generatedLine: -1, generatedColumn: 0};
}

/**
 * Iterate through internal items. This method takes the same arguments that
 * `Array.prototype.forEach` takes.
 *
 * NOTE: The order of the mappings is NOT guaranteed.
 */
MappingList$1.prototype.unsortedForEach =
  function MappingList_forEach(aCallback, aThisArg) {
    this._array.forEach(aCallback, aThisArg);
  };

/**
 * Add the given source mapping.
 *
 * @param Object aMapping
 */
MappingList$1.prototype.add = function MappingList_add(aMapping) {
  if (generatedPositionAfter(this._last, aMapping)) {
    this._last = aMapping;
    this._array.push(aMapping);
  } else {
    this._sorted = false;
    this._array.push(aMapping);
  }
};

/**
 * Returns the flat, sorted array of mappings. The mappings are sorted by
 * generated position.
 *
 * WARNING: This method returns internal data without copying, for
 * performance. The return value must NOT be mutated, and should be treated as
 * an immutable borrow. If you want to take ownership, you must make your own
 * copy.
 */
MappingList$1.prototype.toArray = function MappingList_toArray() {
  if (!this._sorted) {
    this._array.sort(util$3.compareByGeneratedPositionsInflated);
    this._sorted = true;
  }
  return this._array;
};

mappingList.MappingList = MappingList$1;

/* -*- Mode: js; js-indent-level: 2; -*- */

/*
 * Copyright 2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */

var base64VLQ$1 = base64Vlq;
var util$2 = util$5;
var ArraySet$1 = arraySet.ArraySet;
var MappingList = mappingList.MappingList;

/**
 * An instance of the SourceMapGenerator represents a source map which is
 * being built incrementally. You may pass an object with the following
 * properties:
 *
 *   - file: The filename of the generated source.
 *   - sourceRoot: A root for all relative URLs in this source map.
 */
function SourceMapGenerator$1(aArgs) {
  if (!aArgs) {
    aArgs = {};
  }
  this._file = util$2.getArg(aArgs, 'file', null);
  this._sourceRoot = util$2.getArg(aArgs, 'sourceRoot', null);
  this._skipValidation = util$2.getArg(aArgs, 'skipValidation', false);
  this._sources = new ArraySet$1();
  this._names = new ArraySet$1();
  this._mappings = new MappingList();
  this._sourcesContents = null;
}

SourceMapGenerator$1.prototype._version = 3;

/**
 * Creates a new SourceMapGenerator based on a SourceMapConsumer
 *
 * @param aSourceMapConsumer The SourceMap.
 */
SourceMapGenerator$1.fromSourceMap =
  function SourceMapGenerator_fromSourceMap(aSourceMapConsumer) {
    var sourceRoot = aSourceMapConsumer.sourceRoot;
    var generator = new SourceMapGenerator$1({
      file: aSourceMapConsumer.file,
      sourceRoot: sourceRoot
    });
    aSourceMapConsumer.eachMapping(function (mapping) {
      var newMapping = {
        generated: {
          line: mapping.generatedLine,
          column: mapping.generatedColumn
        }
      };

      if (mapping.source != null) {
        newMapping.source = mapping.source;
        if (sourceRoot != null) {
          newMapping.source = util$2.relative(sourceRoot, newMapping.source);
        }

        newMapping.original = {
          line: mapping.originalLine,
          column: mapping.originalColumn
        };

        if (mapping.name != null) {
          newMapping.name = mapping.name;
        }
      }

      generator.addMapping(newMapping);
    });
    aSourceMapConsumer.sources.forEach(function (sourceFile) {
      var sourceRelative = sourceFile;
      if (sourceRoot !== null) {
        sourceRelative = util$2.relative(sourceRoot, sourceFile);
      }

      if (!generator._sources.has(sourceRelative)) {
        generator._sources.add(sourceRelative);
      }

      var content = aSourceMapConsumer.sourceContentFor(sourceFile);
      if (content != null) {
        generator.setSourceContent(sourceFile, content);
      }
    });
    return generator;
  };

/**
 * Add a single mapping from original source line and column to the generated
 * source's line and column for this source map being created. The mapping
 * object should have the following properties:
 *
 *   - generated: An object with the generated line and column positions.
 *   - original: An object with the original line and column positions.
 *   - source: The original source file (relative to the sourceRoot).
 *   - name: An optional original token name for this mapping.
 */
SourceMapGenerator$1.prototype.addMapping =
  function SourceMapGenerator_addMapping(aArgs) {
    var generated = util$2.getArg(aArgs, 'generated');
    var original = util$2.getArg(aArgs, 'original', null);
    var source = util$2.getArg(aArgs, 'source', null);
    var name = util$2.getArg(aArgs, 'name', null);

    if (!this._skipValidation) {
      this._validateMapping(generated, original, source, name);
    }

    if (source != null) {
      source = String(source);
      if (!this._sources.has(source)) {
        this._sources.add(source);
      }
    }

    if (name != null) {
      name = String(name);
      if (!this._names.has(name)) {
        this._names.add(name);
      }
    }

    this._mappings.add({
      generatedLine: generated.line,
      generatedColumn: generated.column,
      originalLine: original != null && original.line,
      originalColumn: original != null && original.column,
      source: source,
      name: name
    });
  };

/**
 * Set the source content for a source file.
 */
SourceMapGenerator$1.prototype.setSourceContent =
  function SourceMapGenerator_setSourceContent(aSourceFile, aSourceContent) {
    var source = aSourceFile;
    if (this._sourceRoot != null) {
      source = util$2.relative(this._sourceRoot, source);
    }

    if (aSourceContent != null) {
      // Add the source content to the _sourcesContents map.
      // Create a new _sourcesContents map if the property is null.
      if (!this._sourcesContents) {
        this._sourcesContents = Object.create(null);
      }
      this._sourcesContents[util$2.toSetString(source)] = aSourceContent;
    } else if (this._sourcesContents) {
      // Remove the source file from the _sourcesContents map.
      // If the _sourcesContents map is empty, set the property to null.
      delete this._sourcesContents[util$2.toSetString(source)];
      if (Object.keys(this._sourcesContents).length === 0) {
        this._sourcesContents = null;
      }
    }
  };

/**
 * Applies the mappings of a sub-source-map for a specific source file to the
 * source map being generated. Each mapping to the supplied source file is
 * rewritten using the supplied source map. Note: The resolution for the
 * resulting mappings is the minimium of this map and the supplied map.
 *
 * @param aSourceMapConsumer The source map to be applied.
 * @param aSourceFile Optional. The filename of the source file.
 *        If omitted, SourceMapConsumer's file property will be used.
 * @param aSourceMapPath Optional. The dirname of the path to the source map
 *        to be applied. If relative, it is relative to the SourceMapConsumer.
 *        This parameter is needed when the two source maps aren't in the same
 *        directory, and the source map to be applied contains relative source
 *        paths. If so, those relative source paths need to be rewritten
 *        relative to the SourceMapGenerator.
 */
SourceMapGenerator$1.prototype.applySourceMap =
  function SourceMapGenerator_applySourceMap(aSourceMapConsumer, aSourceFile, aSourceMapPath) {
    var sourceFile = aSourceFile;
    // If aSourceFile is omitted, we will use the file property of the SourceMap
    if (aSourceFile == null) {
      if (aSourceMapConsumer.file == null) {
        throw new Error(
          'SourceMapGenerator.prototype.applySourceMap requires either an explicit source file, ' +
          'or the source map\'s "file" property. Both were omitted.'
        );
      }
      sourceFile = aSourceMapConsumer.file;
    }
    var sourceRoot = this._sourceRoot;
    // Make "sourceFile" relative if an absolute Url is passed.
    if (sourceRoot != null) {
      sourceFile = util$2.relative(sourceRoot, sourceFile);
    }
    // Applying the SourceMap can add and remove items from the sources and
    // the names array.
    var newSources = new ArraySet$1();
    var newNames = new ArraySet$1();

    // Find mappings for the "sourceFile"
    this._mappings.unsortedForEach(function (mapping) {
      if (mapping.source === sourceFile && mapping.originalLine != null) {
        // Check if it can be mapped by the source map, then update the mapping.
        var original = aSourceMapConsumer.originalPositionFor({
          line: mapping.originalLine,
          column: mapping.originalColumn
        });
        if (original.source != null) {
          // Copy mapping
          mapping.source = original.source;
          if (aSourceMapPath != null) {
            mapping.source = util$2.join(aSourceMapPath, mapping.source);
          }
          if (sourceRoot != null) {
            mapping.source = util$2.relative(sourceRoot, mapping.source);
          }
          mapping.originalLine = original.line;
          mapping.originalColumn = original.column;
          if (original.name != null) {
            mapping.name = original.name;
          }
        }
      }

      var source = mapping.source;
      if (source != null && !newSources.has(source)) {
        newSources.add(source);
      }

      var name = mapping.name;
      if (name != null && !newNames.has(name)) {
        newNames.add(name);
      }

    }, this);
    this._sources = newSources;
    this._names = newNames;

    // Copy sourcesContents of applied map.
    aSourceMapConsumer.sources.forEach(function (sourceFile) {
      var content = aSourceMapConsumer.sourceContentFor(sourceFile);
      if (content != null) {
        if (aSourceMapPath != null) {
          sourceFile = util$2.join(aSourceMapPath, sourceFile);
        }
        if (sourceRoot != null) {
          sourceFile = util$2.relative(sourceRoot, sourceFile);
        }
        this.setSourceContent(sourceFile, content);
      }
    }, this);
  };

/**
 * A mapping can have one of the three levels of data:
 *
 *   1. Just the generated position.
 *   2. The Generated position, original position, and original source.
 *   3. Generated and original position, original source, as well as a name
 *      token.
 *
 * To maintain consistency, we validate that any new mapping being added falls
 * in to one of these categories.
 */
SourceMapGenerator$1.prototype._validateMapping =
  function SourceMapGenerator_validateMapping(aGenerated, aOriginal, aSource,
                                              aName) {
    // When aOriginal is truthy but has empty values for .line and .column,
    // it is most likely a programmer error. In this case we throw a very
    // specific error message to try to guide them the right way.
    // For example: https://github.com/Polymer/polymer-bundler/pull/519
    if (aOriginal && typeof aOriginal.line !== 'number' && typeof aOriginal.column !== 'number') {
        throw new Error(
            'original.line and original.column are not numbers -- you probably meant to omit ' +
            'the original mapping entirely and only map the generated position. If so, pass ' +
            'null for the original mapping instead of an object with empty or null values.'
        );
    }

    if (aGenerated && 'line' in aGenerated && 'column' in aGenerated
        && aGenerated.line > 0 && aGenerated.column >= 0
        && !aOriginal && !aSource && !aName) {
      // Case 1.
      return;
    }
    else if (aGenerated && 'line' in aGenerated && 'column' in aGenerated
             && aOriginal && 'line' in aOriginal && 'column' in aOriginal
             && aGenerated.line > 0 && aGenerated.column >= 0
             && aOriginal.line > 0 && aOriginal.column >= 0
             && aSource) {
      // Cases 2 and 3.
      return;
    }
    else {
      throw new Error('Invalid mapping: ' + JSON.stringify({
        generated: aGenerated,
        source: aSource,
        original: aOriginal,
        name: aName
      }));
    }
  };

/**
 * Serialize the accumulated mappings in to the stream of base 64 VLQs
 * specified by the source map format.
 */
SourceMapGenerator$1.prototype._serializeMappings =
  function SourceMapGenerator_serializeMappings() {
    var previousGeneratedColumn = 0;
    var previousGeneratedLine = 1;
    var previousOriginalColumn = 0;
    var previousOriginalLine = 0;
    var previousName = 0;
    var previousSource = 0;
    var result = '';
    var next;
    var mapping;
    var nameIdx;
    var sourceIdx;

    var mappings = this._mappings.toArray();
    for (var i = 0, len = mappings.length; i < len; i++) {
      mapping = mappings[i];
      next = '';

      if (mapping.generatedLine !== previousGeneratedLine) {
        previousGeneratedColumn = 0;
        while (mapping.generatedLine !== previousGeneratedLine) {
          next += ';';
          previousGeneratedLine++;
        }
      }
      else {
        if (i > 0) {
          if (!util$2.compareByGeneratedPositionsInflated(mapping, mappings[i - 1])) {
            continue;
          }
          next += ',';
        }
      }

      next += base64VLQ$1.encode(mapping.generatedColumn
                                 - previousGeneratedColumn);
      previousGeneratedColumn = mapping.generatedColumn;

      if (mapping.source != null) {
        sourceIdx = this._sources.indexOf(mapping.source);
        next += base64VLQ$1.encode(sourceIdx - previousSource);
        previousSource = sourceIdx;

        // lines are stored 0-based in SourceMap spec version 3
        next += base64VLQ$1.encode(mapping.originalLine - 1
                                   - previousOriginalLine);
        previousOriginalLine = mapping.originalLine - 1;

        next += base64VLQ$1.encode(mapping.originalColumn
                                   - previousOriginalColumn);
        previousOriginalColumn = mapping.originalColumn;

        if (mapping.name != null) {
          nameIdx = this._names.indexOf(mapping.name);
          next += base64VLQ$1.encode(nameIdx - previousName);
          previousName = nameIdx;
        }
      }

      result += next;
    }

    return result;
  };

SourceMapGenerator$1.prototype._generateSourcesContent =
  function SourceMapGenerator_generateSourcesContent(aSources, aSourceRoot) {
    return aSources.map(function (source) {
      if (!this._sourcesContents) {
        return null;
      }
      if (aSourceRoot != null) {
        source = util$2.relative(aSourceRoot, source);
      }
      var key = util$2.toSetString(source);
      return Object.prototype.hasOwnProperty.call(this._sourcesContents, key)
        ? this._sourcesContents[key]
        : null;
    }, this);
  };

/**
 * Externalize the source map.
 */
SourceMapGenerator$1.prototype.toJSON =
  function SourceMapGenerator_toJSON() {
    var map = {
      version: this._version,
      sources: this._sources.toArray(),
      names: this._names.toArray(),
      mappings: this._serializeMappings()
    };
    if (this._file != null) {
      map.file = this._file;
    }
    if (this._sourceRoot != null) {
      map.sourceRoot = this._sourceRoot;
    }
    if (this._sourcesContents) {
      map.sourcesContent = this._generateSourcesContent(map.sources, map.sourceRoot);
    }

    return map;
  };

/**
 * Render the source map being generated to a string.
 */
SourceMapGenerator$1.prototype.toString =
  function SourceMapGenerator_toString() {
    return JSON.stringify(this.toJSON());
  };

sourceMapGenerator.SourceMapGenerator = SourceMapGenerator$1;

var sourceMapConsumer = {};

var binarySearch$1 = {};

/* -*- Mode: js; js-indent-level: 2; -*- */

(function (exports) {
	/*
	 * Copyright 2011 Mozilla Foundation and contributors
	 * Licensed under the New BSD license. See LICENSE or:
	 * http://opensource.org/licenses/BSD-3-Clause
	 */

	exports.GREATEST_LOWER_BOUND = 1;
	exports.LEAST_UPPER_BOUND = 2;

	/**
	 * Recursive implementation of binary search.
	 *
	 * @param aLow Indices here and lower do not contain the needle.
	 * @param aHigh Indices here and higher do not contain the needle.
	 * @param aNeedle The element being searched for.
	 * @param aHaystack The non-empty array being searched.
	 * @param aCompare Function which takes two elements and returns -1, 0, or 1.
	 * @param aBias Either 'binarySearch.GREATEST_LOWER_BOUND' or
	 *     'binarySearch.LEAST_UPPER_BOUND'. Specifies whether to return the
	 *     closest element that is smaller than or greater than the one we are
	 *     searching for, respectively, if the exact element cannot be found.
	 */
	function recursiveSearch(aLow, aHigh, aNeedle, aHaystack, aCompare, aBias) {
	  // This function terminates when one of the following is true:
	  //
	  //   1. We find the exact element we are looking for.
	  //
	  //   2. We did not find the exact element, but we can return the index of
	  //      the next-closest element.
	  //
	  //   3. We did not find the exact element, and there is no next-closest
	  //      element than the one we are searching for, so we return -1.
	  var mid = Math.floor((aHigh - aLow) / 2) + aLow;
	  var cmp = aCompare(aNeedle, aHaystack[mid], true);
	  if (cmp === 0) {
	    // Found the element we are looking for.
	    return mid;
	  }
	  else if (cmp > 0) {
	    // Our needle is greater than aHaystack[mid].
	    if (aHigh - mid > 1) {
	      // The element is in the upper half.
	      return recursiveSearch(mid, aHigh, aNeedle, aHaystack, aCompare, aBias);
	    }

	    // The exact needle element was not found in this haystack. Determine if
	    // we are in termination case (3) or (2) and return the appropriate thing.
	    if (aBias == exports.LEAST_UPPER_BOUND) {
	      return aHigh < aHaystack.length ? aHigh : -1;
	    } else {
	      return mid;
	    }
	  }
	  else {
	    // Our needle is less than aHaystack[mid].
	    if (mid - aLow > 1) {
	      // The element is in the lower half.
	      return recursiveSearch(aLow, mid, aNeedle, aHaystack, aCompare, aBias);
	    }

	    // we are in termination case (3) or (2) and return the appropriate thing.
	    if (aBias == exports.LEAST_UPPER_BOUND) {
	      return mid;
	    } else {
	      return aLow < 0 ? -1 : aLow;
	    }
	  }
	}

	/**
	 * This is an implementation of binary search which will always try and return
	 * the index of the closest element if there is no exact hit. This is because
	 * mappings between original and generated line/col pairs are single points,
	 * and there is an implicit region between each of them, so a miss just means
	 * that you aren't on the very start of a region.
	 *
	 * @param aNeedle The element you are looking for.
	 * @param aHaystack The array that is being searched.
	 * @param aCompare A function which takes the needle and an element in the
	 *     array and returns -1, 0, or 1 depending on whether the needle is less
	 *     than, equal to, or greater than the element, respectively.
	 * @param aBias Either 'binarySearch.GREATEST_LOWER_BOUND' or
	 *     'binarySearch.LEAST_UPPER_BOUND'. Specifies whether to return the
	 *     closest element that is smaller than or greater than the one we are
	 *     searching for, respectively, if the exact element cannot be found.
	 *     Defaults to 'binarySearch.GREATEST_LOWER_BOUND'.
	 */
	exports.search = function search(aNeedle, aHaystack, aCompare, aBias) {
	  if (aHaystack.length === 0) {
	    return -1;
	  }

	  var index = recursiveSearch(-1, aHaystack.length, aNeedle, aHaystack,
	                              aCompare, aBias || exports.GREATEST_LOWER_BOUND);
	  if (index < 0) {
	    return -1;
	  }

	  // We have found either the exact element, or the next-closest element than
	  // the one we are searching for. However, there may be more than one such
	  // element. Make sure we always return the smallest of these.
	  while (index - 1 >= 0) {
	    if (aCompare(aHaystack[index], aHaystack[index - 1], true) !== 0) {
	      break;
	    }
	    --index;
	  }

	  return index;
	};
} (binarySearch$1));

var quickSort$1 = {};

/* -*- Mode: js; js-indent-level: 2; -*- */

/*
 * Copyright 2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */

// It turns out that some (most?) JavaScript engines don't self-host
// `Array.prototype.sort`. This makes sense because C++ will likely remain
// faster than JS when doing raw CPU-intensive sorting. However, when using a
// custom comparator function, calling back and forth between the VM's C++ and
// JIT'd JS is rather slow *and* loses JIT type information, resulting in
// worse generated code for the comparator function than would be optimal. In
// fact, when sorting with a comparator, these costs outweigh the benefits of
// sorting in C++. By using our own JS-implemented Quick Sort (below), we get
// a ~3500ms mean speed-up in `bench/bench.html`.

/**
 * Swap the elements indexed by `x` and `y` in the array `ary`.
 *
 * @param {Array} ary
 *        The array.
 * @param {Number} x
 *        The index of the first item.
 * @param {Number} y
 *        The index of the second item.
 */
function swap(ary, x, y) {
  var temp = ary[x];
  ary[x] = ary[y];
  ary[y] = temp;
}

/**
 * Returns a random integer within the range `low .. high` inclusive.
 *
 * @param {Number} low
 *        The lower bound on the range.
 * @param {Number} high
 *        The upper bound on the range.
 */
function randomIntInRange(low, high) {
  return Math.round(low + (Math.random() * (high - low)));
}

/**
 * The Quick Sort algorithm.
 *
 * @param {Array} ary
 *        An array to sort.
 * @param {function} comparator
 *        Function to use to compare two items.
 * @param {Number} p
 *        Start index of the array
 * @param {Number} r
 *        End index of the array
 */
function doQuickSort(ary, comparator, p, r) {
  // If our lower bound is less than our upper bound, we (1) partition the
  // array into two pieces and (2) recurse on each half. If it is not, this is
  // the empty array and our base case.

  if (p < r) {
    // (1) Partitioning.
    //
    // The partitioning chooses a pivot between `p` and `r` and moves all
    // elements that are less than or equal to the pivot to the before it, and
    // all the elements that are greater than it after it. The effect is that
    // once partition is done, the pivot is in the exact place it will be when
    // the array is put in sorted order, and it will not need to be moved
    // again. This runs in O(n) time.

    // Always choose a random pivot so that an input array which is reverse
    // sorted does not cause O(n^2) running time.
    var pivotIndex = randomIntInRange(p, r);
    var i = p - 1;

    swap(ary, pivotIndex, r);
    var pivot = ary[r];

    // Immediately after `j` is incremented in this loop, the following hold
    // true:
    //
    //   * Every element in `ary[p .. i]` is less than or equal to the pivot.
    //
    //   * Every element in `ary[i+1 .. j-1]` is greater than the pivot.
    for (var j = p; j < r; j++) {
      if (comparator(ary[j], pivot) <= 0) {
        i += 1;
        swap(ary, i, j);
      }
    }

    swap(ary, i + 1, j);
    var q = i + 1;

    // (2) Recurse on each half.

    doQuickSort(ary, comparator, p, q - 1);
    doQuickSort(ary, comparator, q + 1, r);
  }
}

/**
 * Sort the given array in-place with the given comparator function.
 *
 * @param {Array} ary
 *        An array to sort.
 * @param {function} comparator
 *        Function to use to compare two items.
 */
quickSort$1.quickSort = function (ary, comparator) {
  doQuickSort(ary, comparator, 0, ary.length - 1);
};

/* -*- Mode: js; js-indent-level: 2; -*- */

/*
 * Copyright 2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */

var util$1 = util$5;
var binarySearch = binarySearch$1;
var ArraySet = arraySet.ArraySet;
var base64VLQ = base64Vlq;
var quickSort = quickSort$1.quickSort;

function SourceMapConsumer$1(aSourceMap, aSourceMapURL) {
  var sourceMap = aSourceMap;
  if (typeof aSourceMap === 'string') {
    sourceMap = util$1.parseSourceMapInput(aSourceMap);
  }

  return sourceMap.sections != null
    ? new IndexedSourceMapConsumer(sourceMap, aSourceMapURL)
    : new BasicSourceMapConsumer(sourceMap, aSourceMapURL);
}

SourceMapConsumer$1.fromSourceMap = function(aSourceMap, aSourceMapURL) {
  return BasicSourceMapConsumer.fromSourceMap(aSourceMap, aSourceMapURL);
};

/**
 * The version of the source mapping spec that we are consuming.
 */
SourceMapConsumer$1.prototype._version = 3;

// `__generatedMappings` and `__originalMappings` are arrays that hold the
// parsed mapping coordinates from the source map's "mappings" attribute. They
// are lazily instantiated, accessed via the `_generatedMappings` and
// `_originalMappings` getters respectively, and we only parse the mappings
// and create these arrays once queried for a source location. We jump through
// these hoops because there can be many thousands of mappings, and parsing
// them is expensive, so we only want to do it if we must.
//
// Each object in the arrays is of the form:
//
//     {
//       generatedLine: The line number in the generated code,
//       generatedColumn: The column number in the generated code,
//       source: The path to the original source file that generated this
//               chunk of code,
//       originalLine: The line number in the original source that
//                     corresponds to this chunk of generated code,
//       originalColumn: The column number in the original source that
//                       corresponds to this chunk of generated code,
//       name: The name of the original symbol which generated this chunk of
//             code.
//     }
//
// All properties except for `generatedLine` and `generatedColumn` can be
// `null`.
//
// `_generatedMappings` is ordered by the generated positions.
//
// `_originalMappings` is ordered by the original positions.

SourceMapConsumer$1.prototype.__generatedMappings = null;
Object.defineProperty(SourceMapConsumer$1.prototype, '_generatedMappings', {
  configurable: true,
  enumerable: true,
  get: function () {
    if (!this.__generatedMappings) {
      this._parseMappings(this._mappings, this.sourceRoot);
    }

    return this.__generatedMappings;
  }
});

SourceMapConsumer$1.prototype.__originalMappings = null;
Object.defineProperty(SourceMapConsumer$1.prototype, '_originalMappings', {
  configurable: true,
  enumerable: true,
  get: function () {
    if (!this.__originalMappings) {
      this._parseMappings(this._mappings, this.sourceRoot);
    }

    return this.__originalMappings;
  }
});

SourceMapConsumer$1.prototype._charIsMappingSeparator =
  function SourceMapConsumer_charIsMappingSeparator(aStr, index) {
    var c = aStr.charAt(index);
    return c === ";" || c === ",";
  };

/**
 * Parse the mappings in a string in to a data structure which we can easily
 * query (the ordered arrays in the `this.__generatedMappings` and
 * `this.__originalMappings` properties).
 */
SourceMapConsumer$1.prototype._parseMappings =
  function SourceMapConsumer_parseMappings(aStr, aSourceRoot) {
    throw new Error("Subclasses must implement _parseMappings");
  };

SourceMapConsumer$1.GENERATED_ORDER = 1;
SourceMapConsumer$1.ORIGINAL_ORDER = 2;

SourceMapConsumer$1.GREATEST_LOWER_BOUND = 1;
SourceMapConsumer$1.LEAST_UPPER_BOUND = 2;

/**
 * Iterate over each mapping between an original source/line/column and a
 * generated line/column in this source map.
 *
 * @param Function aCallback
 *        The function that is called with each mapping.
 * @param Object aContext
 *        Optional. If specified, this object will be the value of `this` every
 *        time that `aCallback` is called.
 * @param aOrder
 *        Either `SourceMapConsumer.GENERATED_ORDER` or
 *        `SourceMapConsumer.ORIGINAL_ORDER`. Specifies whether you want to
 *        iterate over the mappings sorted by the generated file's line/column
 *        order or the original's source/line/column order, respectively. Defaults to
 *        `SourceMapConsumer.GENERATED_ORDER`.
 */
SourceMapConsumer$1.prototype.eachMapping =
  function SourceMapConsumer_eachMapping(aCallback, aContext, aOrder) {
    var context = aContext || null;
    var order = aOrder || SourceMapConsumer$1.GENERATED_ORDER;

    var mappings;
    switch (order) {
    case SourceMapConsumer$1.GENERATED_ORDER:
      mappings = this._generatedMappings;
      break;
    case SourceMapConsumer$1.ORIGINAL_ORDER:
      mappings = this._originalMappings;
      break;
    default:
      throw new Error("Unknown order of iteration.");
    }

    var sourceRoot = this.sourceRoot;
    mappings.map(function (mapping) {
      var source = mapping.source === null ? null : this._sources.at(mapping.source);
      source = util$1.computeSourceURL(sourceRoot, source, this._sourceMapURL);
      return {
        source: source,
        generatedLine: mapping.generatedLine,
        generatedColumn: mapping.generatedColumn,
        originalLine: mapping.originalLine,
        originalColumn: mapping.originalColumn,
        name: mapping.name === null ? null : this._names.at(mapping.name)
      };
    }, this).forEach(aCallback, context);
  };

/**
 * Returns all generated line and column information for the original source,
 * line, and column provided. If no column is provided, returns all mappings
 * corresponding to a either the line we are searching for or the next
 * closest line that has any mappings. Otherwise, returns all mappings
 * corresponding to the given line and either the column we are searching for
 * or the next closest column that has any offsets.
 *
 * The only argument is an object with the following properties:
 *
 *   - source: The filename of the original source.
 *   - line: The line number in the original source.  The line number is 1-based.
 *   - column: Optional. the column number in the original source.
 *    The column number is 0-based.
 *
 * and an array of objects is returned, each with the following properties:
 *
 *   - line: The line number in the generated source, or null.  The
 *    line number is 1-based.
 *   - column: The column number in the generated source, or null.
 *    The column number is 0-based.
 */
SourceMapConsumer$1.prototype.allGeneratedPositionsFor =
  function SourceMapConsumer_allGeneratedPositionsFor(aArgs) {
    var line = util$1.getArg(aArgs, 'line');

    // When there is no exact match, BasicSourceMapConsumer.prototype._findMapping
    // returns the index of the closest mapping less than the needle. By
    // setting needle.originalColumn to 0, we thus find the last mapping for
    // the given line, provided such a mapping exists.
    var needle = {
      source: util$1.getArg(aArgs, 'source'),
      originalLine: line,
      originalColumn: util$1.getArg(aArgs, 'column', 0)
    };

    needle.source = this._findSourceIndex(needle.source);
    if (needle.source < 0) {
      return [];
    }

    var mappings = [];

    var index = this._findMapping(needle,
                                  this._originalMappings,
                                  "originalLine",
                                  "originalColumn",
                                  util$1.compareByOriginalPositions,
                                  binarySearch.LEAST_UPPER_BOUND);
    if (index >= 0) {
      var mapping = this._originalMappings[index];

      if (aArgs.column === undefined) {
        var originalLine = mapping.originalLine;

        // Iterate until either we run out of mappings, or we run into
        // a mapping for a different line than the one we found. Since
        // mappings are sorted, this is guaranteed to find all mappings for
        // the line we found.
        while (mapping && mapping.originalLine === originalLine) {
          mappings.push({
            line: util$1.getArg(mapping, 'generatedLine', null),
            column: util$1.getArg(mapping, 'generatedColumn', null),
            lastColumn: util$1.getArg(mapping, 'lastGeneratedColumn', null)
          });

          mapping = this._originalMappings[++index];
        }
      } else {
        var originalColumn = mapping.originalColumn;

        // Iterate until either we run out of mappings, or we run into
        // a mapping for a different line than the one we were searching for.
        // Since mappings are sorted, this is guaranteed to find all mappings for
        // the line we are searching for.
        while (mapping &&
               mapping.originalLine === line &&
               mapping.originalColumn == originalColumn) {
          mappings.push({
            line: util$1.getArg(mapping, 'generatedLine', null),
            column: util$1.getArg(mapping, 'generatedColumn', null),
            lastColumn: util$1.getArg(mapping, 'lastGeneratedColumn', null)
          });

          mapping = this._originalMappings[++index];
        }
      }
    }

    return mappings;
  };

sourceMapConsumer.SourceMapConsumer = SourceMapConsumer$1;

/**
 * A BasicSourceMapConsumer instance represents a parsed source map which we can
 * query for information about the original file positions by giving it a file
 * position in the generated source.
 *
 * The first parameter is the raw source map (either as a JSON string, or
 * already parsed to an object). According to the spec, source maps have the
 * following attributes:
 *
 *   - version: Which version of the source map spec this map is following.
 *   - sources: An array of URLs to the original source files.
 *   - names: An array of identifiers which can be referrenced by individual mappings.
 *   - sourceRoot: Optional. The URL root from which all sources are relative.
 *   - sourcesContent: Optional. An array of contents of the original source files.
 *   - mappings: A string of base64 VLQs which contain the actual mappings.
 *   - file: Optional. The generated file this source map is associated with.
 *
 * Here is an example source map, taken from the source map spec[0]:
 *
 *     {
 *       version : 3,
 *       file: "out.js",
 *       sourceRoot : "",
 *       sources: ["foo.js", "bar.js"],
 *       names: ["src", "maps", "are", "fun"],
 *       mappings: "AA,AB;;ABCDE;"
 *     }
 *
 * The second parameter, if given, is a string whose value is the URL
 * at which the source map was found.  This URL is used to compute the
 * sources array.
 *
 * [0]: https://docs.google.com/document/d/1U1RGAehQwRypUTovF1KRlpiOFze0b-_2gc6fAH0KY0k/edit?pli=1#
 */
function BasicSourceMapConsumer(aSourceMap, aSourceMapURL) {
  var sourceMap = aSourceMap;
  if (typeof aSourceMap === 'string') {
    sourceMap = util$1.parseSourceMapInput(aSourceMap);
  }

  var version = util$1.getArg(sourceMap, 'version');
  var sources = util$1.getArg(sourceMap, 'sources');
  // Sass 3.3 leaves out the 'names' array, so we deviate from the spec (which
  // requires the array) to play nice here.
  var names = util$1.getArg(sourceMap, 'names', []);
  var sourceRoot = util$1.getArg(sourceMap, 'sourceRoot', null);
  var sourcesContent = util$1.getArg(sourceMap, 'sourcesContent', null);
  var mappings = util$1.getArg(sourceMap, 'mappings');
  var file = util$1.getArg(sourceMap, 'file', null);

  // Once again, Sass deviates from the spec and supplies the version as a
  // string rather than a number, so we use loose equality checking here.
  if (version != this._version) {
    throw new Error('Unsupported version: ' + version);
  }

  if (sourceRoot) {
    sourceRoot = util$1.normalize(sourceRoot);
  }

  sources = sources
    .map(String)
    // Some source maps produce relative source paths like "./foo.js" instead of
    // "foo.js".  Normalize these first so that future comparisons will succeed.
    // See bugzil.la/1090768.
    .map(util$1.normalize)
    // Always ensure that absolute sources are internally stored relative to
    // the source root, if the source root is absolute. Not doing this would
    // be particularly problematic when the source root is a prefix of the
    // source (valid, but why??). See github issue #199 and bugzil.la/1188982.
    .map(function (source) {
      return sourceRoot && util$1.isAbsolute(sourceRoot) && util$1.isAbsolute(source)
        ? util$1.relative(sourceRoot, source)
        : source;
    });

  // Pass `true` below to allow duplicate names and sources. While source maps
  // are intended to be compressed and deduplicated, the TypeScript compiler
  // sometimes generates source maps with duplicates in them. See Github issue
  // #72 and bugzil.la/889492.
  this._names = ArraySet.fromArray(names.map(String), true);
  this._sources = ArraySet.fromArray(sources, true);

  this._absoluteSources = this._sources.toArray().map(function (s) {
    return util$1.computeSourceURL(sourceRoot, s, aSourceMapURL);
  });

  this.sourceRoot = sourceRoot;
  this.sourcesContent = sourcesContent;
  this._mappings = mappings;
  this._sourceMapURL = aSourceMapURL;
  this.file = file;
}

BasicSourceMapConsumer.prototype = Object.create(SourceMapConsumer$1.prototype);
BasicSourceMapConsumer.prototype.consumer = SourceMapConsumer$1;

/**
 * Utility function to find the index of a source.  Returns -1 if not
 * found.
 */
BasicSourceMapConsumer.prototype._findSourceIndex = function(aSource) {
  var relativeSource = aSource;
  if (this.sourceRoot != null) {
    relativeSource = util$1.relative(this.sourceRoot, relativeSource);
  }

  if (this._sources.has(relativeSource)) {
    return this._sources.indexOf(relativeSource);
  }

  // Maybe aSource is an absolute URL as returned by |sources|.  In
  // this case we can't simply undo the transform.
  var i;
  for (i = 0; i < this._absoluteSources.length; ++i) {
    if (this._absoluteSources[i] == aSource) {
      return i;
    }
  }

  return -1;
};

/**
 * Create a BasicSourceMapConsumer from a SourceMapGenerator.
 *
 * @param SourceMapGenerator aSourceMap
 *        The source map that will be consumed.
 * @param String aSourceMapURL
 *        The URL at which the source map can be found (optional)
 * @returns BasicSourceMapConsumer
 */
BasicSourceMapConsumer.fromSourceMap =
  function SourceMapConsumer_fromSourceMap(aSourceMap, aSourceMapURL) {
    var smc = Object.create(BasicSourceMapConsumer.prototype);

    var names = smc._names = ArraySet.fromArray(aSourceMap._names.toArray(), true);
    var sources = smc._sources = ArraySet.fromArray(aSourceMap._sources.toArray(), true);
    smc.sourceRoot = aSourceMap._sourceRoot;
    smc.sourcesContent = aSourceMap._generateSourcesContent(smc._sources.toArray(),
                                                            smc.sourceRoot);
    smc.file = aSourceMap._file;
    smc._sourceMapURL = aSourceMapURL;
    smc._absoluteSources = smc._sources.toArray().map(function (s) {
      return util$1.computeSourceURL(smc.sourceRoot, s, aSourceMapURL);
    });

    // Because we are modifying the entries (by converting string sources and
    // names to indices into the sources and names ArraySets), we have to make
    // a copy of the entry or else bad things happen. Shared mutable state
    // strikes again! See github issue #191.

    var generatedMappings = aSourceMap._mappings.toArray().slice();
    var destGeneratedMappings = smc.__generatedMappings = [];
    var destOriginalMappings = smc.__originalMappings = [];

    for (var i = 0, length = generatedMappings.length; i < length; i++) {
      var srcMapping = generatedMappings[i];
      var destMapping = new Mapping;
      destMapping.generatedLine = srcMapping.generatedLine;
      destMapping.generatedColumn = srcMapping.generatedColumn;

      if (srcMapping.source) {
        destMapping.source = sources.indexOf(srcMapping.source);
        destMapping.originalLine = srcMapping.originalLine;
        destMapping.originalColumn = srcMapping.originalColumn;

        if (srcMapping.name) {
          destMapping.name = names.indexOf(srcMapping.name);
        }

        destOriginalMappings.push(destMapping);
      }

      destGeneratedMappings.push(destMapping);
    }

    quickSort(smc.__originalMappings, util$1.compareByOriginalPositions);

    return smc;
  };

/**
 * The version of the source mapping spec that we are consuming.
 */
BasicSourceMapConsumer.prototype._version = 3;

/**
 * The list of original sources.
 */
Object.defineProperty(BasicSourceMapConsumer.prototype, 'sources', {
  get: function () {
    return this._absoluteSources.slice();
  }
});

/**
 * Provide the JIT with a nice shape / hidden class.
 */
function Mapping() {
  this.generatedLine = 0;
  this.generatedColumn = 0;
  this.source = null;
  this.originalLine = null;
  this.originalColumn = null;
  this.name = null;
}

/**
 * Parse the mappings in a string in to a data structure which we can easily
 * query (the ordered arrays in the `this.__generatedMappings` and
 * `this.__originalMappings` properties).
 */
BasicSourceMapConsumer.prototype._parseMappings =
  function SourceMapConsumer_parseMappings(aStr, aSourceRoot) {
    var generatedLine = 1;
    var previousGeneratedColumn = 0;
    var previousOriginalLine = 0;
    var previousOriginalColumn = 0;
    var previousSource = 0;
    var previousName = 0;
    var length = aStr.length;
    var index = 0;
    var cachedSegments = {};
    var temp = {};
    var originalMappings = [];
    var generatedMappings = [];
    var mapping, str, segment, end, value;

    while (index < length) {
      if (aStr.charAt(index) === ';') {
        generatedLine++;
        index++;
        previousGeneratedColumn = 0;
      }
      else if (aStr.charAt(index) === ',') {
        index++;
      }
      else {
        mapping = new Mapping();
        mapping.generatedLine = generatedLine;

        // Because each offset is encoded relative to the previous one,
        // many segments often have the same encoding. We can exploit this
        // fact by caching the parsed variable length fields of each segment,
        // allowing us to avoid a second parse if we encounter the same
        // segment again.
        for (end = index; end < length; end++) {
          if (this._charIsMappingSeparator(aStr, end)) {
            break;
          }
        }
        str = aStr.slice(index, end);

        segment = cachedSegments[str];
        if (segment) {
          index += str.length;
        } else {
          segment = [];
          while (index < end) {
            base64VLQ.decode(aStr, index, temp);
            value = temp.value;
            index = temp.rest;
            segment.push(value);
          }

          if (segment.length === 2) {
            throw new Error('Found a source, but no line and column');
          }

          if (segment.length === 3) {
            throw new Error('Found a source and line, but no column');
          }

          cachedSegments[str] = segment;
        }

        // Generated column.
        mapping.generatedColumn = previousGeneratedColumn + segment[0];
        previousGeneratedColumn = mapping.generatedColumn;

        if (segment.length > 1) {
          // Original source.
          mapping.source = previousSource + segment[1];
          previousSource += segment[1];

          // Original line.
          mapping.originalLine = previousOriginalLine + segment[2];
          previousOriginalLine = mapping.originalLine;
          // Lines are stored 0-based
          mapping.originalLine += 1;

          // Original column.
          mapping.originalColumn = previousOriginalColumn + segment[3];
          previousOriginalColumn = mapping.originalColumn;

          if (segment.length > 4) {
            // Original name.
            mapping.name = previousName + segment[4];
            previousName += segment[4];
          }
        }

        generatedMappings.push(mapping);
        if (typeof mapping.originalLine === 'number') {
          originalMappings.push(mapping);
        }
      }
    }

    quickSort(generatedMappings, util$1.compareByGeneratedPositionsDeflated);
    this.__generatedMappings = generatedMappings;

    quickSort(originalMappings, util$1.compareByOriginalPositions);
    this.__originalMappings = originalMappings;
  };

/**
 * Find the mapping that best matches the hypothetical "needle" mapping that
 * we are searching for in the given "haystack" of mappings.
 */
BasicSourceMapConsumer.prototype._findMapping =
  function SourceMapConsumer_findMapping(aNeedle, aMappings, aLineName,
                                         aColumnName, aComparator, aBias) {
    // To return the position we are searching for, we must first find the
    // mapping for the given position and then return the opposite position it
    // points to. Because the mappings are sorted, we can use binary search to
    // find the best mapping.

    if (aNeedle[aLineName] <= 0) {
      throw new TypeError('Line must be greater than or equal to 1, got '
                          + aNeedle[aLineName]);
    }
    if (aNeedle[aColumnName] < 0) {
      throw new TypeError('Column must be greater than or equal to 0, got '
                          + aNeedle[aColumnName]);
    }

    return binarySearch.search(aNeedle, aMappings, aComparator, aBias);
  };

/**
 * Compute the last column for each generated mapping. The last column is
 * inclusive.
 */
BasicSourceMapConsumer.prototype.computeColumnSpans =
  function SourceMapConsumer_computeColumnSpans() {
    for (var index = 0; index < this._generatedMappings.length; ++index) {
      var mapping = this._generatedMappings[index];

      // Mappings do not contain a field for the last generated columnt. We
      // can come up with an optimistic estimate, however, by assuming that
      // mappings are contiguous (i.e. given two consecutive mappings, the
      // first mapping ends where the second one starts).
      if (index + 1 < this._generatedMappings.length) {
        var nextMapping = this._generatedMappings[index + 1];

        if (mapping.generatedLine === nextMapping.generatedLine) {
          mapping.lastGeneratedColumn = nextMapping.generatedColumn - 1;
          continue;
        }
      }

      // The last mapping for each line spans the entire line.
      mapping.lastGeneratedColumn = Infinity;
    }
  };

/**
 * Returns the original source, line, and column information for the generated
 * source's line and column positions provided. The only argument is an object
 * with the following properties:
 *
 *   - line: The line number in the generated source.  The line number
 *     is 1-based.
 *   - column: The column number in the generated source.  The column
 *     number is 0-based.
 *   - bias: Either 'SourceMapConsumer.GREATEST_LOWER_BOUND' or
 *     'SourceMapConsumer.LEAST_UPPER_BOUND'. Specifies whether to return the
 *     closest element that is smaller than or greater than the one we are
 *     searching for, respectively, if the exact element cannot be found.
 *     Defaults to 'SourceMapConsumer.GREATEST_LOWER_BOUND'.
 *
 * and an object is returned with the following properties:
 *
 *   - source: The original source file, or null.
 *   - line: The line number in the original source, or null.  The
 *     line number is 1-based.
 *   - column: The column number in the original source, or null.  The
 *     column number is 0-based.
 *   - name: The original identifier, or null.
 */
BasicSourceMapConsumer.prototype.originalPositionFor =
  function SourceMapConsumer_originalPositionFor(aArgs) {
    var needle = {
      generatedLine: util$1.getArg(aArgs, 'line'),
      generatedColumn: util$1.getArg(aArgs, 'column')
    };

    var index = this._findMapping(
      needle,
      this._generatedMappings,
      "generatedLine",
      "generatedColumn",
      util$1.compareByGeneratedPositionsDeflated,
      util$1.getArg(aArgs, 'bias', SourceMapConsumer$1.GREATEST_LOWER_BOUND)
    );

    if (index >= 0) {
      var mapping = this._generatedMappings[index];

      if (mapping.generatedLine === needle.generatedLine) {
        var source = util$1.getArg(mapping, 'source', null);
        if (source !== null) {
          source = this._sources.at(source);
          source = util$1.computeSourceURL(this.sourceRoot, source, this._sourceMapURL);
        }
        var name = util$1.getArg(mapping, 'name', null);
        if (name !== null) {
          name = this._names.at(name);
        }
        return {
          source: source,
          line: util$1.getArg(mapping, 'originalLine', null),
          column: util$1.getArg(mapping, 'originalColumn', null),
          name: name
        };
      }
    }

    return {
      source: null,
      line: null,
      column: null,
      name: null
    };
  };

/**
 * Return true if we have the source content for every source in the source
 * map, false otherwise.
 */
BasicSourceMapConsumer.prototype.hasContentsOfAllSources =
  function BasicSourceMapConsumer_hasContentsOfAllSources() {
    if (!this.sourcesContent) {
      return false;
    }
    return this.sourcesContent.length >= this._sources.size() &&
      !this.sourcesContent.some(function (sc) { return sc == null; });
  };

/**
 * Returns the original source content. The only argument is the url of the
 * original source file. Returns null if no original source content is
 * available.
 */
BasicSourceMapConsumer.prototype.sourceContentFor =
  function SourceMapConsumer_sourceContentFor(aSource, nullOnMissing) {
    if (!this.sourcesContent) {
      return null;
    }

    var index = this._findSourceIndex(aSource);
    if (index >= 0) {
      return this.sourcesContent[index];
    }

    var relativeSource = aSource;
    if (this.sourceRoot != null) {
      relativeSource = util$1.relative(this.sourceRoot, relativeSource);
    }

    var url;
    if (this.sourceRoot != null
        && (url = util$1.urlParse(this.sourceRoot))) {
      // XXX: file:// URIs and absolute paths lead to unexpected behavior for
      // many users. We can help them out when they expect file:// URIs to
      // behave like it would if they were running a local HTTP server. See
      // https://bugzilla.mozilla.org/show_bug.cgi?id=885597.
      var fileUriAbsPath = relativeSource.replace(/^file:\/\//, "");
      if (url.scheme == "file"
          && this._sources.has(fileUriAbsPath)) {
        return this.sourcesContent[this._sources.indexOf(fileUriAbsPath)]
      }

      if ((!url.path || url.path == "/")
          && this._sources.has("/" + relativeSource)) {
        return this.sourcesContent[this._sources.indexOf("/" + relativeSource)];
      }
    }

    // This function is used recursively from
    // IndexedSourceMapConsumer.prototype.sourceContentFor. In that case, we
    // don't want to throw if we can't find the source - we just want to
    // return null, so we provide a flag to exit gracefully.
    if (nullOnMissing) {
      return null;
    }
    else {
      throw new Error('"' + relativeSource + '" is not in the SourceMap.');
    }
  };

/**
 * Returns the generated line and column information for the original source,
 * line, and column positions provided. The only argument is an object with
 * the following properties:
 *
 *   - source: The filename of the original source.
 *   - line: The line number in the original source.  The line number
 *     is 1-based.
 *   - column: The column number in the original source.  The column
 *     number is 0-based.
 *   - bias: Either 'SourceMapConsumer.GREATEST_LOWER_BOUND' or
 *     'SourceMapConsumer.LEAST_UPPER_BOUND'. Specifies whether to return the
 *     closest element that is smaller than or greater than the one we are
 *     searching for, respectively, if the exact element cannot be found.
 *     Defaults to 'SourceMapConsumer.GREATEST_LOWER_BOUND'.
 *
 * and an object is returned with the following properties:
 *
 *   - line: The line number in the generated source, or null.  The
 *     line number is 1-based.
 *   - column: The column number in the generated source, or null.
 *     The column number is 0-based.
 */
BasicSourceMapConsumer.prototype.generatedPositionFor =
  function SourceMapConsumer_generatedPositionFor(aArgs) {
    var source = util$1.getArg(aArgs, 'source');
    source = this._findSourceIndex(source);
    if (source < 0) {
      return {
        line: null,
        column: null,
        lastColumn: null
      };
    }

    var needle = {
      source: source,
      originalLine: util$1.getArg(aArgs, 'line'),
      originalColumn: util$1.getArg(aArgs, 'column')
    };

    var index = this._findMapping(
      needle,
      this._originalMappings,
      "originalLine",
      "originalColumn",
      util$1.compareByOriginalPositions,
      util$1.getArg(aArgs, 'bias', SourceMapConsumer$1.GREATEST_LOWER_BOUND)
    );

    if (index >= 0) {
      var mapping = this._originalMappings[index];

      if (mapping.source === needle.source) {
        return {
          line: util$1.getArg(mapping, 'generatedLine', null),
          column: util$1.getArg(mapping, 'generatedColumn', null),
          lastColumn: util$1.getArg(mapping, 'lastGeneratedColumn', null)
        };
      }
    }

    return {
      line: null,
      column: null,
      lastColumn: null
    };
  };

sourceMapConsumer.BasicSourceMapConsumer = BasicSourceMapConsumer;

/**
 * An IndexedSourceMapConsumer instance represents a parsed source map which
 * we can query for information. It differs from BasicSourceMapConsumer in
 * that it takes "indexed" source maps (i.e. ones with a "sections" field) as
 * input.
 *
 * The first parameter is a raw source map (either as a JSON string, or already
 * parsed to an object). According to the spec for indexed source maps, they
 * have the following attributes:
 *
 *   - version: Which version of the source map spec this map is following.
 *   - file: Optional. The generated file this source map is associated with.
 *   - sections: A list of section definitions.
 *
 * Each value under the "sections" field has two fields:
 *   - offset: The offset into the original specified at which this section
 *       begins to apply, defined as an object with a "line" and "column"
 *       field.
 *   - map: A source map definition. This source map could also be indexed,
 *       but doesn't have to be.
 *
 * Instead of the "map" field, it's also possible to have a "url" field
 * specifying a URL to retrieve a source map from, but that's currently
 * unsupported.
 *
 * Here's an example source map, taken from the source map spec[0], but
 * modified to omit a section which uses the "url" field.
 *
 *  {
 *    version : 3,
 *    file: "app.js",
 *    sections: [{
 *      offset: {line:100, column:10},
 *      map: {
 *        version : 3,
 *        file: "section.js",
 *        sources: ["foo.js", "bar.js"],
 *        names: ["src", "maps", "are", "fun"],
 *        mappings: "AAAA,E;;ABCDE;"
 *      }
 *    }],
 *  }
 *
 * The second parameter, if given, is a string whose value is the URL
 * at which the source map was found.  This URL is used to compute the
 * sources array.
 *
 * [0]: https://docs.google.com/document/d/1U1RGAehQwRypUTovF1KRlpiOFze0b-_2gc6fAH0KY0k/edit#heading=h.535es3xeprgt
 */
function IndexedSourceMapConsumer(aSourceMap, aSourceMapURL) {
  var sourceMap = aSourceMap;
  if (typeof aSourceMap === 'string') {
    sourceMap = util$1.parseSourceMapInput(aSourceMap);
  }

  var version = util$1.getArg(sourceMap, 'version');
  var sections = util$1.getArg(sourceMap, 'sections');

  if (version != this._version) {
    throw new Error('Unsupported version: ' + version);
  }

  this._sources = new ArraySet();
  this._names = new ArraySet();

  var lastOffset = {
    line: -1,
    column: 0
  };
  this._sections = sections.map(function (s) {
    if (s.url) {
      // The url field will require support for asynchronicity.
      // See https://github.com/mozilla/source-map/issues/16
      throw new Error('Support for url field in sections not implemented.');
    }
    var offset = util$1.getArg(s, 'offset');
    var offsetLine = util$1.getArg(offset, 'line');
    var offsetColumn = util$1.getArg(offset, 'column');

    if (offsetLine < lastOffset.line ||
        (offsetLine === lastOffset.line && offsetColumn < lastOffset.column)) {
      throw new Error('Section offsets must be ordered and non-overlapping.');
    }
    lastOffset = offset;

    return {
      generatedOffset: {
        // The offset fields are 0-based, but we use 1-based indices when
        // encoding/decoding from VLQ.
        generatedLine: offsetLine + 1,
        generatedColumn: offsetColumn + 1
      },
      consumer: new SourceMapConsumer$1(util$1.getArg(s, 'map'), aSourceMapURL)
    }
  });
}

IndexedSourceMapConsumer.prototype = Object.create(SourceMapConsumer$1.prototype);
IndexedSourceMapConsumer.prototype.constructor = SourceMapConsumer$1;

/**
 * The version of the source mapping spec that we are consuming.
 */
IndexedSourceMapConsumer.prototype._version = 3;

/**
 * The list of original sources.
 */
Object.defineProperty(IndexedSourceMapConsumer.prototype, 'sources', {
  get: function () {
    var sources = [];
    for (var i = 0; i < this._sections.length; i++) {
      for (var j = 0; j < this._sections[i].consumer.sources.length; j++) {
        sources.push(this._sections[i].consumer.sources[j]);
      }
    }
    return sources;
  }
});

/**
 * Returns the original source, line, and column information for the generated
 * source's line and column positions provided. The only argument is an object
 * with the following properties:
 *
 *   - line: The line number in the generated source.  The line number
 *     is 1-based.
 *   - column: The column number in the generated source.  The column
 *     number is 0-based.
 *
 * and an object is returned with the following properties:
 *
 *   - source: The original source file, or null.
 *   - line: The line number in the original source, or null.  The
 *     line number is 1-based.
 *   - column: The column number in the original source, or null.  The
 *     column number is 0-based.
 *   - name: The original identifier, or null.
 */
IndexedSourceMapConsumer.prototype.originalPositionFor =
  function IndexedSourceMapConsumer_originalPositionFor(aArgs) {
    var needle = {
      generatedLine: util$1.getArg(aArgs, 'line'),
      generatedColumn: util$1.getArg(aArgs, 'column')
    };

    // Find the section containing the generated position we're trying to map
    // to an original position.
    var sectionIndex = binarySearch.search(needle, this._sections,
      function(needle, section) {
        var cmp = needle.generatedLine - section.generatedOffset.generatedLine;
        if (cmp) {
          return cmp;
        }

        return (needle.generatedColumn -
                section.generatedOffset.generatedColumn);
      });
    var section = this._sections[sectionIndex];

    if (!section) {
      return {
        source: null,
        line: null,
        column: null,
        name: null
      };
    }

    return section.consumer.originalPositionFor({
      line: needle.generatedLine -
        (section.generatedOffset.generatedLine - 1),
      column: needle.generatedColumn -
        (section.generatedOffset.generatedLine === needle.generatedLine
         ? section.generatedOffset.generatedColumn - 1
         : 0),
      bias: aArgs.bias
    });
  };

/**
 * Return true if we have the source content for every source in the source
 * map, false otherwise.
 */
IndexedSourceMapConsumer.prototype.hasContentsOfAllSources =
  function IndexedSourceMapConsumer_hasContentsOfAllSources() {
    return this._sections.every(function (s) {
      return s.consumer.hasContentsOfAllSources();
    });
  };

/**
 * Returns the original source content. The only argument is the url of the
 * original source file. Returns null if no original source content is
 * available.
 */
IndexedSourceMapConsumer.prototype.sourceContentFor =
  function IndexedSourceMapConsumer_sourceContentFor(aSource, nullOnMissing) {
    for (var i = 0; i < this._sections.length; i++) {
      var section = this._sections[i];

      var content = section.consumer.sourceContentFor(aSource, true);
      if (content) {
        return content;
      }
    }
    if (nullOnMissing) {
      return null;
    }
    else {
      throw new Error('"' + aSource + '" is not in the SourceMap.');
    }
  };

/**
 * Returns the generated line and column information for the original source,
 * line, and column positions provided. The only argument is an object with
 * the following properties:
 *
 *   - source: The filename of the original source.
 *   - line: The line number in the original source.  The line number
 *     is 1-based.
 *   - column: The column number in the original source.  The column
 *     number is 0-based.
 *
 * and an object is returned with the following properties:
 *
 *   - line: The line number in the generated source, or null.  The
 *     line number is 1-based. 
 *   - column: The column number in the generated source, or null.
 *     The column number is 0-based.
 */
IndexedSourceMapConsumer.prototype.generatedPositionFor =
  function IndexedSourceMapConsumer_generatedPositionFor(aArgs) {
    for (var i = 0; i < this._sections.length; i++) {
      var section = this._sections[i];

      // Only consider this section if the requested source is in the list of
      // sources of the consumer.
      if (section.consumer._findSourceIndex(util$1.getArg(aArgs, 'source')) === -1) {
        continue;
      }
      var generatedPosition = section.consumer.generatedPositionFor(aArgs);
      if (generatedPosition) {
        var ret = {
          line: generatedPosition.line +
            (section.generatedOffset.generatedLine - 1),
          column: generatedPosition.column +
            (section.generatedOffset.generatedLine === generatedPosition.line
             ? section.generatedOffset.generatedColumn - 1
             : 0)
        };
        return ret;
      }
    }

    return {
      line: null,
      column: null
    };
  };

/**
 * Parse the mappings in a string in to a data structure which we can easily
 * query (the ordered arrays in the `this.__generatedMappings` and
 * `this.__originalMappings` properties).
 */
IndexedSourceMapConsumer.prototype._parseMappings =
  function IndexedSourceMapConsumer_parseMappings(aStr, aSourceRoot) {
    this.__generatedMappings = [];
    this.__originalMappings = [];
    for (var i = 0; i < this._sections.length; i++) {
      var section = this._sections[i];
      var sectionMappings = section.consumer._generatedMappings;
      for (var j = 0; j < sectionMappings.length; j++) {
        var mapping = sectionMappings[j];

        var source = section.consumer._sources.at(mapping.source);
        source = util$1.computeSourceURL(section.consumer.sourceRoot, source, this._sourceMapURL);
        this._sources.add(source);
        source = this._sources.indexOf(source);

        var name = null;
        if (mapping.name) {
          name = section.consumer._names.at(mapping.name);
          this._names.add(name);
          name = this._names.indexOf(name);
        }

        // The mappings coming from the consumer for the section have
        // generated positions relative to the start of the section, so we
        // need to offset them to be relative to the start of the concatenated
        // generated file.
        var adjustedMapping = {
          source: source,
          generatedLine: mapping.generatedLine +
            (section.generatedOffset.generatedLine - 1),
          generatedColumn: mapping.generatedColumn +
            (section.generatedOffset.generatedLine === mapping.generatedLine
            ? section.generatedOffset.generatedColumn - 1
            : 0),
          originalLine: mapping.originalLine,
          originalColumn: mapping.originalColumn,
          name: name
        };

        this.__generatedMappings.push(adjustedMapping);
        if (typeof adjustedMapping.originalLine === 'number') {
          this.__originalMappings.push(adjustedMapping);
        }
      }
    }

    quickSort(this.__generatedMappings, util$1.compareByGeneratedPositionsDeflated);
    quickSort(this.__originalMappings, util$1.compareByOriginalPositions);
  };

sourceMapConsumer.IndexedSourceMapConsumer = IndexedSourceMapConsumer;

/* -*- Mode: js; js-indent-level: 2; -*- */

/*
 * Copyright 2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */

var SourceMapGenerator = sourceMapGenerator.SourceMapGenerator;
var util = util$5;

// Matches a Windows-style `\r\n` newline or a `\n` newline used by all other
// operating systems these days (capturing the result).
var REGEX_NEWLINE = /(\r?\n)/;

// Newline character code for charCodeAt() comparisons
var NEWLINE_CODE = 10;

// Private symbol for identifying `SourceNode`s when multiple versions of
// the source-map library are loaded. This MUST NOT CHANGE across
// versions!
var isSourceNode = "$$$isSourceNode$$$";

/**
 * SourceNodes provide a way to abstract over interpolating/concatenating
 * snippets of generated JavaScript source code while maintaining the line and
 * column information associated with the original source code.
 *
 * @param aLine The original line number.
 * @param aColumn The original column number.
 * @param aSource The original source's filename.
 * @param aChunks Optional. An array of strings which are snippets of
 *        generated JS, or other SourceNodes.
 * @param aName The original identifier.
 */
function SourceNode(aLine, aColumn, aSource, aChunks, aName) {
  this.children = [];
  this.sourceContents = {};
  this.line = aLine == null ? null : aLine;
  this.column = aColumn == null ? null : aColumn;
  this.source = aSource == null ? null : aSource;
  this.name = aName == null ? null : aName;
  this[isSourceNode] = true;
  if (aChunks != null) this.add(aChunks);
}

/**
 * Creates a SourceNode from generated code and a SourceMapConsumer.
 *
 * @param aGeneratedCode The generated code
 * @param aSourceMapConsumer The SourceMap for the generated code
 * @param aRelativePath Optional. The path that relative sources in the
 *        SourceMapConsumer should be relative to.
 */
SourceNode.fromStringWithSourceMap =
  function SourceNode_fromStringWithSourceMap(aGeneratedCode, aSourceMapConsumer, aRelativePath) {
    // The SourceNode we want to fill with the generated code
    // and the SourceMap
    var node = new SourceNode();

    // All even indices of this array are one line of the generated code,
    // while all odd indices are the newlines between two adjacent lines
    // (since `REGEX_NEWLINE` captures its match).
    // Processed fragments are accessed by calling `shiftNextLine`.
    var remainingLines = aGeneratedCode.split(REGEX_NEWLINE);
    var remainingLinesIndex = 0;
    var shiftNextLine = function() {
      var lineContents = getNextLine();
      // The last line of a file might not have a newline.
      var newLine = getNextLine() || "";
      return lineContents + newLine;

      function getNextLine() {
        return remainingLinesIndex < remainingLines.length ?
            remainingLines[remainingLinesIndex++] : undefined;
      }
    };

    // We need to remember the position of "remainingLines"
    var lastGeneratedLine = 1, lastGeneratedColumn = 0;

    // The generate SourceNodes we need a code range.
    // To extract it current and last mapping is used.
    // Here we store the last mapping.
    var lastMapping = null;

    aSourceMapConsumer.eachMapping(function (mapping) {
      if (lastMapping !== null) {
        // We add the code from "lastMapping" to "mapping":
        // First check if there is a new line in between.
        if (lastGeneratedLine < mapping.generatedLine) {
          // Associate first line with "lastMapping"
          addMappingWithCode(lastMapping, shiftNextLine());
          lastGeneratedLine++;
          lastGeneratedColumn = 0;
          // The remaining code is added without mapping
        } else {
          // There is no new line in between.
          // Associate the code between "lastGeneratedColumn" and
          // "mapping.generatedColumn" with "lastMapping"
          var nextLine = remainingLines[remainingLinesIndex] || '';
          var code = nextLine.substr(0, mapping.generatedColumn -
                                        lastGeneratedColumn);
          remainingLines[remainingLinesIndex] = nextLine.substr(mapping.generatedColumn -
                                              lastGeneratedColumn);
          lastGeneratedColumn = mapping.generatedColumn;
          addMappingWithCode(lastMapping, code);
          // No more remaining code, continue
          lastMapping = mapping;
          return;
        }
      }
      // We add the generated code until the first mapping
      // to the SourceNode without any mapping.
      // Each line is added as separate string.
      while (lastGeneratedLine < mapping.generatedLine) {
        node.add(shiftNextLine());
        lastGeneratedLine++;
      }
      if (lastGeneratedColumn < mapping.generatedColumn) {
        var nextLine = remainingLines[remainingLinesIndex] || '';
        node.add(nextLine.substr(0, mapping.generatedColumn));
        remainingLines[remainingLinesIndex] = nextLine.substr(mapping.generatedColumn);
        lastGeneratedColumn = mapping.generatedColumn;
      }
      lastMapping = mapping;
    }, this);
    // We have processed all mappings.
    if (remainingLinesIndex < remainingLines.length) {
      if (lastMapping) {
        // Associate the remaining code in the current line with "lastMapping"
        addMappingWithCode(lastMapping, shiftNextLine());
      }
      // and add the remaining lines without any mapping
      node.add(remainingLines.splice(remainingLinesIndex).join(""));
    }

    // Copy sourcesContent into SourceNode
    aSourceMapConsumer.sources.forEach(function (sourceFile) {
      var content = aSourceMapConsumer.sourceContentFor(sourceFile);
      if (content != null) {
        if (aRelativePath != null) {
          sourceFile = util.join(aRelativePath, sourceFile);
        }
        node.setSourceContent(sourceFile, content);
      }
    });

    return node;

    function addMappingWithCode(mapping, code) {
      if (mapping === null || mapping.source === undefined) {
        node.add(code);
      } else {
        var source = aRelativePath
          ? util.join(aRelativePath, mapping.source)
          : mapping.source;
        node.add(new SourceNode(mapping.originalLine,
                                mapping.originalColumn,
                                source,
                                code,
                                mapping.name));
      }
    }
  };

/**
 * Add a chunk of generated JS to this source node.
 *
 * @param aChunk A string snippet of generated JS code, another instance of
 *        SourceNode, or an array where each member is one of those things.
 */
SourceNode.prototype.add = function SourceNode_add(aChunk) {
  if (Array.isArray(aChunk)) {
    aChunk.forEach(function (chunk) {
      this.add(chunk);
    }, this);
  }
  else if (aChunk[isSourceNode] || typeof aChunk === "string") {
    if (aChunk) {
      this.children.push(aChunk);
    }
  }
  else {
    throw new TypeError(
      "Expected a SourceNode, string, or an array of SourceNodes and strings. Got " + aChunk
    );
  }
  return this;
};

/**
 * Add a chunk of generated JS to the beginning of this source node.
 *
 * @param aChunk A string snippet of generated JS code, another instance of
 *        SourceNode, or an array where each member is one of those things.
 */
SourceNode.prototype.prepend = function SourceNode_prepend(aChunk) {
  if (Array.isArray(aChunk)) {
    for (var i = aChunk.length-1; i >= 0; i--) {
      this.prepend(aChunk[i]);
    }
  }
  else if (aChunk[isSourceNode] || typeof aChunk === "string") {
    this.children.unshift(aChunk);
  }
  else {
    throw new TypeError(
      "Expected a SourceNode, string, or an array of SourceNodes and strings. Got " + aChunk
    );
  }
  return this;
};

/**
 * Walk over the tree of JS snippets in this node and its children. The
 * walking function is called once for each snippet of JS and is passed that
 * snippet and the its original associated source's line/column location.
 *
 * @param aFn The traversal function.
 */
SourceNode.prototype.walk = function SourceNode_walk(aFn) {
  var chunk;
  for (var i = 0, len = this.children.length; i < len; i++) {
    chunk = this.children[i];
    if (chunk[isSourceNode]) {
      chunk.walk(aFn);
    }
    else {
      if (chunk !== '') {
        aFn(chunk, { source: this.source,
                     line: this.line,
                     column: this.column,
                     name: this.name });
      }
    }
  }
};

/**
 * Like `String.prototype.join` except for SourceNodes. Inserts `aStr` between
 * each of `this.children`.
 *
 * @param aSep The separator.
 */
SourceNode.prototype.join = function SourceNode_join(aSep) {
  var newChildren;
  var i;
  var len = this.children.length;
  if (len > 0) {
    newChildren = [];
    for (i = 0; i < len-1; i++) {
      newChildren.push(this.children[i]);
      newChildren.push(aSep);
    }
    newChildren.push(this.children[i]);
    this.children = newChildren;
  }
  return this;
};

/**
 * Call String.prototype.replace on the very right-most source snippet. Useful
 * for trimming whitespace from the end of a source node, etc.
 *
 * @param aPattern The pattern to replace.
 * @param aReplacement The thing to replace the pattern with.
 */
SourceNode.prototype.replaceRight = function SourceNode_replaceRight(aPattern, aReplacement) {
  var lastChild = this.children[this.children.length - 1];
  if (lastChild[isSourceNode]) {
    lastChild.replaceRight(aPattern, aReplacement);
  }
  else if (typeof lastChild === 'string') {
    this.children[this.children.length - 1] = lastChild.replace(aPattern, aReplacement);
  }
  else {
    this.children.push(''.replace(aPattern, aReplacement));
  }
  return this;
};

/**
 * Set the source content for a source file. This will be added to the SourceMapGenerator
 * in the sourcesContent field.
 *
 * @param aSourceFile The filename of the source file
 * @param aSourceContent The content of the source file
 */
SourceNode.prototype.setSourceContent =
  function SourceNode_setSourceContent(aSourceFile, aSourceContent) {
    this.sourceContents[util.toSetString(aSourceFile)] = aSourceContent;
  };

/**
 * Walk over the tree of SourceNodes. The walking function is called for each
 * source file content and is passed the filename and source content.
 *
 * @param aFn The traversal function.
 */
SourceNode.prototype.walkSourceContents =
  function SourceNode_walkSourceContents(aFn) {
    for (var i = 0, len = this.children.length; i < len; i++) {
      if (this.children[i][isSourceNode]) {
        this.children[i].walkSourceContents(aFn);
      }
    }

    var sources = Object.keys(this.sourceContents);
    for (var i = 0, len = sources.length; i < len; i++) {
      aFn(util.fromSetString(sources[i]), this.sourceContents[sources[i]]);
    }
  };

/**
 * Return the string representation of this source node. Walks over the tree
 * and concatenates all the various snippets together to one string.
 */
SourceNode.prototype.toString = function SourceNode_toString() {
  var str = "";
  this.walk(function (chunk) {
    str += chunk;
  });
  return str;
};

/**
 * Returns the string representation of this source node along with a source
 * map.
 */
SourceNode.prototype.toStringWithSourceMap = function SourceNode_toStringWithSourceMap(aArgs) {
  var generated = {
    code: "",
    line: 1,
    column: 0
  };
  var map = new SourceMapGenerator(aArgs);
  var sourceMappingActive = false;
  var lastOriginalSource = null;
  var lastOriginalLine = null;
  var lastOriginalColumn = null;
  var lastOriginalName = null;
  this.walk(function (chunk, original) {
    generated.code += chunk;
    if (original.source !== null
        && original.line !== null
        && original.column !== null) {
      if(lastOriginalSource !== original.source
         || lastOriginalLine !== original.line
         || lastOriginalColumn !== original.column
         || lastOriginalName !== original.name) {
        map.addMapping({
          source: original.source,
          original: {
            line: original.line,
            column: original.column
          },
          generated: {
            line: generated.line,
            column: generated.column
          },
          name: original.name
        });
      }
      lastOriginalSource = original.source;
      lastOriginalLine = original.line;
      lastOriginalColumn = original.column;
      lastOriginalName = original.name;
      sourceMappingActive = true;
    } else if (sourceMappingActive) {
      map.addMapping({
        generated: {
          line: generated.line,
          column: generated.column
        }
      });
      lastOriginalSource = null;
      sourceMappingActive = false;
    }
    for (var idx = 0, length = chunk.length; idx < length; idx++) {
      if (chunk.charCodeAt(idx) === NEWLINE_CODE) {
        generated.line++;
        generated.column = 0;
        // Mappings end at eol
        if (idx + 1 === length) {
          lastOriginalSource = null;
          sourceMappingActive = false;
        } else if (sourceMappingActive) {
          map.addMapping({
            source: original.source,
            original: {
              line: original.line,
              column: original.column
            },
            generated: {
              line: generated.line,
              column: generated.column
            },
            name: original.name
          });
        }
      } else {
        generated.column++;
      }
    }
  });
  this.walkSourceContents(function (sourceFile, sourceContent) {
    map.setSourceContent(sourceFile, sourceContent);
  });

  return { code: generated.code, map: map };
};

/*
 * Copyright 2009-2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE.txt or:
 * http://opensource.org/licenses/BSD-3-Clause
 */
var SourceMapConsumer = sourceMapConsumer.SourceMapConsumer;

/**
 * 校正异常的堆栈信息
 *
 * 由于 rollup 会打包所有代码到一个文件，所以异常的调用栈定位和源码的位置是不同的
 * 本模块就是用来将异常的调用栈映射至源代码位置
 *
 * @see https://github.com/screepers/screeps-typescript-starter/blob/master/src/utils/ErrorMapper.ts
 */

// 缓存 SourceMap
let consumer = null;

// 第一次报错时创建 sourceMap
const getConsumer = function () {
    if (consumer == null) consumer = new SourceMapConsumer(require("main.js.map"));
    return consumer
};

// 缓存映射关系以提高性能
const cache$1 = {};

/**
 * 使用源映射生成堆栈跟踪，并生成原始标志位
 * 警告 - global 重置之后的首次调用会产生很高的 cpu 消耗 (> 30 CPU)
 * 之后的每次调用会产生较低的 cpu 消耗 (~ 0.1 CPU / 次)
 *
 * @param {Error | string} error 错误或原始追踪栈
 * @returns {string} 映射之后的源代码追踪栈
 */
const sourceMappedStackTrace = function (error) {
    const stack = error instanceof Error ? error.stack : error;
    // 有缓存直接用
    if (cache$1.hasOwnProperty(stack)) return cache$1[stack]

    const re = /^\s+at\s+(.+?\s+)?\(?([0-z._\-\\\/]+):(\d+):(\d+)\)?$/gm;
    let match;
    let outStack = error.toString();
    console.log("ErrorMapper -> sourceMappedStackTrace -> outStack", outStack);

    while ((match = re.exec(stack))) {
        // 解析完成
        if (match[2] !== "main") break

        // 获取追踪定位
        const pos = getConsumer().originalPositionFor({
            column: parseInt(match[4], 10),
            line: parseInt(match[3], 10)
        });

        // 无法定位
        if (!pos.line) break

        // 解析追踪栈
        if (pos.name) outStack += `\n    at ${pos.name} (${pos.source}:${pos.line}:${pos.column})`;
        else {
            // 源文件没找到对应文件名，采用原始追踪名
            if (match[1]) outStack += `\n    at ${match[1]} (${pos.source}:${pos.line}:${pos.column})`;
            // 源文件没找到对应文件名并且原始追踪栈里也没有，直接省略
            else outStack += `\n    at ${pos.source}:${pos.line}:${pos.column}`;
        }
    }

    cache$1[stack] = outStack;
    return outStack
};

/**
 * 错误追踪包装器
 * 用于把报错信息通过 source-map 解析成源代码的错误位置
 * 和原本 wrapLoop 的区别是，wrapLoop 会返回一个新函数，而这个会直接执行
 *
 * @param next 玩家代码
 */
const errorMapper = function (next) {
    return () => {
        try {
            // 执行玩家代码
            next();
        }
        catch (e) {
            if (e instanceof Error) {
                // 渲染报错调用栈，沙盒模式用不了这个
                const errorMessage = Game.rooms.sim ?
                    `沙盒模式无法使用 source-map - 显示原始追踪栈<br>${_.escape(e.stack)}` :
                    `${_.escape(sourceMappedStackTrace(e))}`;

                console.log(`<text style="color:#ef9a9a">${errorMessage}</text>`);
            }
            // 处理不了，直接抛出
            else throw e
        }
    }
};

/********************************
author：ChenyangDu
version:1.1

自动布局
【功能】：选定中心位置，自动规划房内布局
【使用方法】：不必获取视野，传入中心点和房间内的控制器、字母矿、能量矿的位置即可（推荐插旗）
1、放置5个旗子，分别对应房间的中心位置(center)、房间的控制器(pc)、
    房间的字母矿(pm)、房间的能量矿(pa、[pb])，pb没有就不放
2、运行以下代码即可

let center = Game.flags.center; // 房间中心的位置
let pa = Game.flags.pa;
let pb = Game.flags.pb;
let pc = Game.flags.pc;
let pm = Game.flags.pm;
if(center) {
    let points = [pc.pos,pm.pos,pa.pos]
    if(pb)points.push(pb.pos)
    require('./建筑规划').run(center.pos,points)
}

【返回结果】:
// 所有位置都用[x,y]表示
{
    structMap, //一个字典，key是建筑名称，val是建筑位置的数组
    roadLength, //一个数组，不同等级路的长度，第0个元素是0
    containers, //一个位置数组，对应[pc,pm,pa,pb]所对应的container
    links, //一个位置数组，对应[pa,pb,中央link]所对应的link
}

【说明】:
1、消耗CPU大概20个左右
2、控制器的container周围3*3区域默认为upgrader区域，不放置建筑，会尽量避免寻路走这里
3、lab的位置会优先选择4*4离中心最远的地方（为了防止一颗核弹同时打lab和中心）
   找不到会选择3*5或者5*3等方案
4、塔位置是随机选了6个rampart然后找最近的
5、link在5级的时候会先造中间的link，然后造离得远的那个
6、中心点尽量往中间选，靠近边界可能出bug
7、先这样吧。。。。虽然有bug但凑活能用了

********************************/

let cache = {};

var build_Layout_v1_1={
    /**
     * @param {RoomPosition} centerpos 房间布局的中心位置
     * @param {RoomPosition[]} points 房间中控制器、字母矿、能量矿的数组
     * @returns 
     */
    CalculateLayout(centerpos,points){
        let name = centerpos.x+'_'+centerpos.y+'_'+centerpos.roomName;
        let ret;
        if(cache[name]){
            ret = cache[name];
        }else {
            cache[name] = ret = autoPlan(centerpos,points);
        }
        // 可视化，不看就关了

        // 以下方法可以按等级标记
        for(let level = 1;level <= 8;level ++){
            for(let type in CONTROLLER_STRUCTURES){
                let lim = CONTROLLER_STRUCTURES[type];
                if(type == 'road')lim = ret.roadLength;
                for(let i = lim[level-1];i<Math.min(ret.structMap[type].length,lim[level]);i++){
                    let e = ret.structMap[type][i];
                    new RoomVisual(centerpos.roomName).text(level,e[0]+0.3,e[1]+0.5,{font:0.4,opacity:0.8});
                }
                if(type == 'container'){
                    for(let i = 0;i<ret.containers.length;i++){
                        let e = ret.containers[i];
                        if((level == 1 && i != 1) || (level == 6 && i == 1)){
                            new RoomVisual(centerpos.roomName).text(level,e[0]+0.3,e[1]+0.5,{font:0.4,opacity:0.8});
                        }
                    }
                    
                }
            }
        }
        // 渲染建筑
        showRoomStructures(centerpos.roomName,ret.structMap);
        return ret
    }
};

/**
 * 
 * @param {RoomPosition} center 
 * @param {RoomPosition[]} points 房间中控制器、字母矿、能量矿的数组
 */
function autoPlan(center,points){
    Game.cpu.getUsed();
    const terrain = new Room.Terrain(center.roomName);

    let part = [
        // 弃用的一种布局模式，虽然也能凑活用
        // [1,0,0,0,0,1],
        // [0,1,0,0,1,0],
        // [0,0,1,1,0,0],
        // [0,0,1,1,0,0],
        // [0,1,0,0,1,0],
        // [1,0,0,0,0,1],
        [1,0,0,0],
        [0,1,0,1],
        [0,0,1,0],
        [0,1,0,1],
    ];
    let structMap = {};
    _.keys(CONTROLLER_STRUCTURES).forEach(e=>structMap[e] = []);

    let roomCost = new RoomArray$3();
    let centerPath = new RoomArray$3();
    let centerPathRoad = new RoomArray$3();
    let roadMap = new RoomArray$3();

    roomCost.initRoomTerrain(center.roomName);
    centerPath.init();
    centerPathRoad.init();
    roadMap.init();

    // 边界不能放
    roomCost.forBorder((x,y,val)=>{
        if(terrain.get(x,y) == 0){
            roomCost.forNear((x,y,val)=>{
                roomCost.set(x,y,0xff);
            },x,y,1);
        }
    });
    // 放ramp
    roomCost.forBorder((x,y,val)=>{
        if(terrain.get(x,y) == 0){
            roomCost.forRange((x,y,val)=>{
                if(val != 0xff){
                    structMap[STRUCTURE_RAMPART].push([x,y]);
                    roomCost.set(x,y,0xff);
                }
            },x,y,2);
        }
    });
    // 边界不能放
    roomCost.forBorder((x,y,val)=>{
        if(terrain.get(x,y) == 0){
            roomCost.forNear((x,y,val)=>{
                if(val != 0xff){
                    roomCost.set(x,y,100);
                }
            },x,y,4);
        }
    });

    // 处理矿点和控制器[控制器、字母矿、矿a、(矿b)]
    {
        let costs = new PathFinder.CostMatrix;
        roomCost.forEach((x,y,val)=>{costs.set(x,y,val);});
        
        if(points.length > 0){
            let max_cnt = 0; // 周围的空地数量
        
            let containerPoses = [];
    
            roomCost.forRange((_x,_y,val)=>{
                if(val == 0xff)return
                let pos = new RoomPosition(_x,_y,center.roomName);
                
                let cnt = 0;
                roomCost.forNear((x,y,val)=>{
                    if(val!=0xff){
                        cnt++;
                    }
                },pos.x,pos.y);
                if(cnt > max_cnt){
                    containerPoses = [];
                    containerPoses.push(pos);
                    max_cnt = cnt;
                }else if(cnt == max_cnt){
                    containerPoses.push(pos);
                }
                
            },points[0].x,points[0].y,2);
            
            containerPoses.forEach(pos=>{
                let ret = PathFinder.search(
                    pos, {pos:center,range:2},
                    {
                        roomCallback:()=>costs,
                        maxRooms:1
                    }
                );
                containerPoses.pathlen = ret.path.length;
            });
            containerPoses.sort(a=>a.pathlen);
            let containerPos = _.head(containerPoses);
            
            if(containerPos){
                structMap[STRUCTURE_CONTAINER].push([containerPos.x,containerPos.y]);
                roomCost.set(containerPos.x,containerPos.y,0xff);
                costs.set(containerPos.x,containerPos.y,0xff);
                roomCost.forNear((x,y,val)=>{
                    roomCost.set(x,y,90);
                    costs.set(x,y,90);
                },containerPos.x,containerPos.y);
            }
        }
        for(let i=1;i<points.length;i++){
            let x,y;
            [x,y] = [points[i].x,points[i].y];
            let ret = PathFinder.search(
                new RoomPosition(x,y,center.roomName), {pos:center,range:1},
                {
                    roomCallback:()=>costs,
                    maxRooms:1
                }
            );
            let path = ret.path;
            if(path.length){
                let pos = path[0];
                structMap[STRUCTURE_CONTAINER].push([pos.x,pos.y]);
                roomCost.set(pos.x,pos.y,0xff);
                costs.set(pos.x,pos.y,0xff);

                if(i>1){
                    let linkPoses = [];
                    roomCost.forNear((x,y,val)=>{
                        if(val < 0xff)linkPoses.push([x,y]);
                    },pos.x,pos.y);
                    let linkpos = null;
                    let minRange = 50;
                    linkPoses.forEach(e=>{
                        let range = getRange(e,[center.x,center.y]);
                        if(range < minRange){
                            minRange = range;
                            linkpos = e;
                        }
                        if(range == minRange && e[0]!=pos.x&&e[1]!=pos.y){ // 尽可能对角排列不堵路
                            linkpos = e;
                        }
                    });
                    
                    if(linkpos){
                        structMap[STRUCTURE_LINK].push(linkpos);
                        roomCost.set(linkpos[0],linkpos[1],0xff);
                        costs.set(linkpos[0],linkpos[1],0xff);

                    }
                }
            }else {
                console.log("no path");
            }
            
        }
    }
    

    roadMap.forEach((x,y,val)=>{
        if(part[(x-center.x+50)%part.length][(y-center.y+50)%part[0].length] == 1 
        && roomCost.get(x,y) < 90){
            roadMap.set(x,y,1);
        }
    });

    // 计算按目前的路径，距离中心的距离
    let updateCenterPathRoad = function(x,y,val,onlyroad = true){
        let _que = [[x,y,val]];
        centerPathRoad.set(x,y,val);
        while(_que.length){
            let top = _que.shift();
            centerPathRoad.forNear((x,y,val)=>{
                if((val == 0 || val > top[2]+1) && roomCost.get(x,y) != 0xff &&
                 (!onlyroad || roadMap.get(x,y)==1)){
                    _que.push([x,y,top[2]+1]);
                    centerPathRoad.set(x,y,top[2]+1);
                }
            },top[0],top[1]);
        }
    };

    updateCenterPathRoad(center.x,center.y,1);

    let que_border4 = [];
    // 计算按默认地形到达中心点的路程
    let que = [[center.x,center.y,1]];
    centerPath.set(center.x,center.y,1);
    while(que.length){
        let top = que.shift();
        let x = top[0];
        let y = top[1];
        // 如果默认地形和目前路径计算结果相差太大，或者不可达，就新建路径
        
        if(roadMap.get(x,y)==1&&(centerPathRoad.get(x,y)==0||centerPathRoad.get(x,y)-centerPath.get(x,y)>4)){
            
            let ret = PathFinder.search(
                center, new RoomPosition(x,y,center.roomName),
                {
                  roomCallback: function(roomName) {
                    let costs = new PathFinder.CostMatrix;
                    roomCost.forEach((x,y,val)=>{
                        if(roadMap.get(x,y) == 1)costs.set(x,y,1);
                        else costs.set(x,y,val);
                    });
                    return costs;
                  },
                  maxRooms:1
                }
            );
            ret.path.forEach(pos=>{
                if(roadMap.get(pos.x,pos.y)==0){
                    
                    let minRoadLength = 10000;
                    centerPathRoad.forNear((x,y,val)=>{
                        if(val > 0 && val < minRoadLength && roadMap.get(x,y)==1){
                            minRoadLength = val;
                        }
                    },pos.x,pos.y);
                    updateCenterPathRoad(pos.x,pos.y,minRoadLength+1);
                    roadMap.set(pos.x,pos.y,1);
                    // new RoomVisual(center.roomName).text(
                    //     minRoadLength+1,
                    //     pos,
                    //     {
                    //         font:0.4,
                    //         color:"#ff0"
                    //     }
                    // )
                }
            });
        }
        
        // 如果靠近边界就放入队列，为之后删除多余ramp做准备
        if(x==5||x==44||y==5||y==44){
            que_border4.push(top);
        }

        centerPath.forNear((x,y,val)=>{
            if(val == 0 && roomCost.get(x,y) < 100){
                que.push([x,y,top[2]+1]);
                centerPath.set(x,y,top[2]+1);
            }
        },x,y);
    }

    // 删除多余的ramp
    while(que_border4.length){
        let top = que_border4.shift();
        let x = top[0];
        let y = top[1];
        centerPath.forNear((x,y,val)=>{
            if(val == 0 && roomCost.get(x,y) != 0xff){
                que_border4.push([x,y,top[2]+1]);
                centerPath.set(x,y,top[2]+1);
            }
        },x,y);
    }

    for(let i=0;i<structMap[STRUCTURE_RAMPART].length;i++){
        let ramp = structMap[STRUCTURE_RAMPART][i];
        let use = false;
        centerPath.forNear((x,y,val)=>{
            if( val)use = true;
            // if()
        },ramp[0],ramp[1]);
        if(!use){
            structMap[STRUCTURE_RAMPART].splice(i,1);
            i--;
        }
    }

    // roomCost.forEach((x,y,val)=>{
    //     new RoomVisual(center.roomName).text(
    //         val,x,y,{
    //             font:0.5,
    //             opacity:0.5
    //         }
    //     )
    // })

    centerPathRoad.init();
    {
        // 计算哪些点适合放建筑
        let structCnt = 0;
        let roadque = [[center.x,center.y,1]];// 路的队列
        let structque = [];// 建筑的队列
        let visited = new RoomArray$3();
        visited.init();
        // 用两个队列，先处理建筑的，并且建筑一加到队列中，就立即在地图上标记，
        // 路反过来，等从队列中取出，需要扩展的时候才加入地图
        centerPathRoad.set(center.x,center.y,1);
        visited.set(center.x,center.y,1);
        while((roadque.length || structque.length) && structCnt < 86){
            let top,x,y;
            top = structque.length?structque.shift():roadque.shift();
            x = top[0];
            y = top[1];
            
            if(roadMap.get(x,y) == 1){
                centerPathRoad.set(x,y,top[2]);
                centerPathRoad.forNear((x,y,val)=>{
                    if((val == 0 || val > top[2]+1) && roomCost.get(x,y) < 100
                         && visited.get(x,y) == 0){
                        if(roadMap.get(x,y) == 1){
                            roadque.push([x,y,top[2]+1]);
                            visited.set(x,y,1);
                        }
                        else {
                            if(structCnt < 86 && roomCost.get(x,y) < 90){
                                structque.push([x,y,top[2]+1]);
                                visited.set(x,y,1);
                                structCnt++;
                                roadMap.set(x,y,2);
                                centerPathRoad.set(x,y,top[2]+1);
                            }
                        }
                    }
                },x,y);
            }
        }
    }

    // 删除不挨着的
    roadMap.forEach((x,y,val)=>{
        if(centerPathRoad.get(x,y)==0)roadMap.set(x,y,0);
    });
    // console.log(Game.cpu.getUsed()-cpu)

    // 处理tower
    {
        // 随机选6个ramp，选择最近的建筑，如果距离在20以上就作废
        let seed = 1;
        while(structMap[STRUCTURE_TOWER].length<6){
            const len = structMap[STRUCTURE_RAMPART].length;
            let ramp = structMap[STRUCTURE_RAMPART][(547*seed)%len];
            let towerPos = null;
            let min_range = 50;
            roadMap.forEach((x,y,val)=>{
                if(val == 2){
                    let range = getRange(ramp,[x,y]);
                    if(range < min_range){
                        min_range = range;
                        towerPos = [x,y];
                    }
                }
            });
            if(towerPos && (min_range < 20 || seed > 20)){
                structMap[STRUCTURE_TOWER].push(towerPos);
                roadMap.set(towerPos[0],towerPos[1],3);
                // new RoomVisual(center.roomName).line(
                //     towerPos[0],towerPos[1],ramp[0],ramp[1],{
                //         color:'#f00'
                //     }
                // )
            }
            seed++;
        }
    }

    // 处理lab
    let labCenter = null;
    {
        let sumExt = new RoomArray$3();
        sumExt.init();
        roadMap.forEach((x,y,val)=>{
            if(x && y){
                sumExt.set(x,y,((val===2)?1:0)+sumExt.get(x,y-1)+sumExt.get(x-1,y)-sumExt.get(x-1,y-1));
            }
        });
        let getlab = function(len_x,len_y){
            let labPos = null;
            let max_range = 0;
            sumExt.forEach((x,y,val)=>{
                let xt = x-len_x;
                let yt = y-len_y;
                if(verify(xt,yt) && sumExt.get(x,y) - sumExt.get(xt,y)-sumExt.get(x,yt)+sumExt.get(xt,yt) >=10){
                    let range = getRange([x-(len_x-1)/2,y-(len_y-1)/2],[center.x,center.y]);
                    if(range > max_range){
                        max_range = range;
                        labPos = {x,y};
                    }
                }
            });
            if(labPos){
                for(let x = labPos.x-len_x+1;x<=labPos.x;x++)
                for(let y = labPos.y-len_y+1;y<=labPos.y;y++){
                    if(roadMap.get(x,y)==2){
                        roadMap.set(x,y,3);
                        structMap[STRUCTURE_LAB].push([x,y]);
                    }
                }
                labCenter = [labPos.x-(len_x-1)/2,labPos.y-(len_y-1)/2];
                return true
            }
            return false
        };
        // lab的三种方案，可以证明一定存在两个lab到达其他lab的距离在2以内
        getlab(4,4)||getlab(3,5)||getlab(5,3);
        
    }
    
    // 处理nuker observe
    {
        let cache = [[0,0,0],[0,0,0]];
        roadMap.forEach((x,y,val)=>{
            if(val==2){
                if(centerPath.get(x,y) > cache[1][2]){
                    cache[1] = [x,y,centerPath.get(x,y)];
                }
                
                if(cache[1][2] > cache[0][2]){
                    [cache[0],cache[1]] = [cache[1],cache[0]];
                }
            }
        });
        structMap[STRUCTURE_OBSERVER].push([cache[0][0],cache[0][1]]);
        structMap[STRUCTURE_NUKER].push([cache[1][0],cache[1][1]]);
        roadMap.set(cache[0][0],cache[0][1],3);
        roadMap.set(cache[1][0],cache[1][1],3);
    }

    // 处理中央集群
    {
        let structures = ['link','storage','terminal','factory','powerSpawn','spawn','spawn','spawn'];
        let range = 1;
        while(structures.length){
            let put = function(incenter){
                roadMap.forRange((x,y,val)=>{
                    if(val == 2 && structures.length &&
                        (!incenter || (x==center.x || y==center.y))){
                        let type = structures.shift();
                        structMap[type].push([x,y]);
                        roadMap.set(x,y,3);
                    }
                },center.x,center.y,range);
            };
            put(true);
            put(false);
            

            range++;
        }
    }

    // 处理extension
    structMap['road'] = [];
    structMap[STRUCTURE_EXTENSION] = [];
    roadMap.forEach((x,y,val)=>{
        if(val == 1)structMap['road'].push([x,y]);
        if(val == 2)structMap[STRUCTURE_EXTENSION].push([x,y]);
    });

    // 记录container、link原来对应的位置
    let containers = [],links = [];
    structMap['container'].forEach(p=>containers.push(p));
    structMap['link'].forEach(p=>links.push(p));
    
    // 连接矿/控制器
    {
        let costs = new PathFinder.CostMatrix;
        let terrain = new Room.Terrain(center.roomName);
        roadMap.forEach((x,y,val)=>{
            let te = terrain.get(x,y);
            costs.set(x,y,te==TERRAIN_MASK_WALL?255:(te==TERRAIN_MASK_SWAMP?4:2));
        });
        for(let struct of OBSTACLE_OBJECT_TYPES){
            if(structMap[struct]){
                structMap[struct].forEach(e=>{
                    costs.set(e[0],e[1],0xff);
                });
            }
        }
        // 控制器周围的消耗提高
        if(structMap["container"].length>0){
            roadMap.forNear((x,y,val)=>{
                costs.set(x,y,10);
            },structMap["container"][0][0],structMap["container"][0][1]);
        }
        
        structMap["road"].forEach(e=>{
            costs.set(e[0],e[1],1);
        });
        
        structMap["container"].sort((a,b)=>getRange(a,[center.x,center.y])-getRange(b,[center.x,center.y]));
        structMap["container"].forEach(e=>{
            let ret = PathFinder.search(
                center,
                {pos:new RoomPosition(e[0],e[1],center.roomName),range:1}, 
                {
                    roomCallback:()=>{return costs},
                    maxRooms:1
                }
            );
            let lastCenterLength;
            ret.path.forEach(pos=>{
                if(costs.get(pos.x,pos.y) != 1){
                    structMap['road'].push([pos.x,pos.y]);
                    costs.set(pos.x,pos.y,1);
                }
                if(centerPathRoad.get(pos.x,pos.y) != 0){
                    lastCenterLength = centerPathRoad.get(pos.x,pos.y);
                }else {
                    lastCenterLength ++;
                    centerPathRoad.set(pos.x,pos.y,lastCenterLength);
                    roadMap.set(pos.x,pos.y,1);
                }
            });
            centerPathRoad.set(e[0],e[1],lastCenterLength+1);
            roadMap.set(e[0],e[1],2);
        });
    }

    
    // 删除多余的建筑
    for(let type in structMap){
        if(type == 'lab'){
            structMap[type].sort((a,b)=>getRange(a,labCenter)-getRange(b,labCenter));
        }else if(type == 'link'){
            structMap[type].sort((a,b)=>getRange(a,[center.x,center.y])-getRange(b,[center.x,center.y]));
            if(structMap[type].length == 3){
                [structMap[type][2],structMap[type][1]] = [structMap[type][1],structMap[type][2]];
            }
        }else
        {
            structMap[type].sort((a,b)=>centerPathRoad.get(a[0],a[1])-centerPathRoad.get(b[0],b[1]));
        }
    }
    let roads = {};
    for(let level = 8;level > 0;level --){
        roads[level] = [];
        for(let type in structMap){
            let length = Math.min(structMap[type].length,CONTROLLER_STRUCTURES[type][level]);
            structMap[type].slice(length).forEach(e=>{
                roadMap.set(e[0],e[1],0);
            });
            
            // if(level >= Game.time % 8)
            //     structMap[type] = structMap[type].slice(0,length)
        }
        if(level == 5 && containers.length >= 2){ // 删掉miner周围的container
            roadMap.set(containers[1][0],containers[1][1],0);
        }
        for(let i = structMap['road'].length-1;i>=0;i--){
            let x = structMap['road'][i][0];
            let y = structMap['road'][i][1];
            let val = centerPathRoad.get(x,y);
            // 周围有其他建筑或路径且只能通过本路到达则标记有用
            let need = false;
            centerPathRoad.forNear((_x,_y,_val)=>{
                if(!need && _val == val+1 && roadMap.get(_x,_y) > 0){ // 路径或建筑
                    need = true;
                    centerPathRoad.forNear((__x,__y,__val)=>{
                        if(need && (__x != x || __y != y) && __val == val 
                        && roadMap.get(__x,__y) == 1)need = false;
                    },_x,_y);
                }
            },x,y);
            if(!need){
                roadMap.set(x,y,0);
                let re = structMap['road'].splice(i,1);
                if(level < 8){
                    roads[level + 1].push(re[0]);
                }
            }
        }
    }
    let roadLength = [0,structMap['road'].length];
    for(let level = 2;level <= 8;level ++){
        if(roads[level].length)
            structMap['road'] = structMap['road'].concat(roads[level]);
        roadLength.push(structMap['road'].length);
        // console.log(roadLength)
    }
    
    // let level = 1;
    // for(let i = 0;i<structMap['road'].length;i++){
    //     while(i >= roadLength[level])level ++
    //     let e = structMap['road'][i]
    //     new RoomVisual(center.roomName).text(level,e[0],e[1]+0.5,{font:0.5,opacity:0.5})
    // }
    

    // console.log(Game.cpu.getUsed()-cpu)
    return {structMap,roadLength,containers,links};

    // let cnt = {}
    // roadMap.forEach((x,y,val)=>{
    //     if(roadMap.get(x,y) == 1){
    //         let a = centerPathRoad.get(x,y)
    //         let b = centerPath.get(x,y)
    //         new RoomVisual(center.roomName).text(
    //             a,x,y+0.2,
    //             {
    //                 font:0.4,
    //                 color:"#f00"
    //             }
    //         )
    //         new RoomVisual(center.roomName).text(
    //             b,x,y-0.2,
    //             {
    //                 font:0.4,
    //                 color:"#00f"
    //             }
    //         )
    //     }else{
    //         new RoomVisual(center.roomName).text(
    //             centerPath.get(x,y),x,y,
    //             {
    //                 font:0.5,
    //                 color:val?"#0ff":0
    //             }
    //         )
    //     }
    //     if(!cnt[val])cnt[val] = 0;
    //     cnt[val]++;
    // })
    
    
}
// 可视化

const structuresShape$1= {
    "spawn": "◎",
    "extension": "ⓔ",
    "link": "◈",
    "road": "•",
    "constructedWall": "▓",
    "rampart": "⊙",
    "storage": "▤",
    "tower": "🔫",
    "observer": "👀",
    "powerSpawn": "❂",
    "extractor": "⇌",
    "terminal": "✡",
    "lab": "☢",
    "container": "□",
    "nuker": "▲",
    "factory": "☭"
};
const structuresColor$1= {
    "spawn": "cyan",
    "extension": "#0bb118",
    "link": "yellow",
    "road": "#fa6f6f",
    "constructedWall": "#003fff",
    "rampart": "#003fff",
    "storage": "yellow",
    "tower": "cyan",
    "observer": "yellow",
    "powerSpawn": "cyan",
    "extractor": "cyan",
    "terminal": "yellow",
    "lab": "#d500ff",
    "container": "yellow",
    "nuker": "cyan",
    "factory": "yellow"
};

function showRoomStructures(roomName,structMap){
    let roomStructs = new RoomArray$3().init();
    const visual = new RoomVisual(roomName);
    structMap["road"].forEach(e=>roomStructs.set(e[0],e[1],"road"));
    for(let struct in structMap){
        if(struct=="road"){
            structMap[struct].forEach(e=>{
                roomStructs.forNear((x,y,val)=>{
                    if(val =="road"&&((e[0]>=x&&e[1]>=y)||(e[0]>x&&e[1]<y)))visual.line(x,y,e[0],e[1],{color:structuresColor$1[struct]});
                },e[0],e[1]);
                visual.text(structuresShape$1[struct], e[0],e[1]+0.25, {color: structuresColor$1[struct],opacity:0.75,fontSize: 7});
            });
        }
        else structMap[struct].forEach(e=>visual.text(structuresShape$1[struct], e[0],e[1]+0.25, {color: structuresColor$1[struct],opacity:0.75,fontSize: 7}));
    }
}

let getRange=function(a,b){
    return Math.max(Math.abs(a[0]-b[0]),Math.abs(a[1]-b[1]))
};

// 房间数组类
function verify(x,y){
    return x>=0&&x<50&&y>=0&&y<50
}
let RoomArray_proto= {
    exec(x,y,val){
        let tmp = this.arr[x*50+y];
        this.set(x,y,val);
        return tmp
    },
    get(x,y){
        return this.arr[x*50+y];
    },
    set(x,y,value){
        this.arr[x*50+y]=value;
    },
    init(){
        if(!this.arr)
            this.arr = new Array(50*50);
        for(let i=0;i<2500;i++){
            this.arr[i]=0;
        }
        return this;
    },
    forEach(func){
        for(let y = 0; y < 50; y++) {
            for(let x = 0; x < 50; x++) {
                func(x,y,this.get(x,y));
            }
        }
    },
    for4Direction(func,x,y,range=1){
        for(let e of [[1,0],[-1,0],[0,1],[0,-1]]){
            let xt=x+e[0];
            let yt=y+e[1];
            if(verify(xt,yt))
                func(xt,yt,this.get(xt,yt));
        }
    },
    forNear(func,x,y,range=1){
        for(let i=-range;i<=range;i++){
            for(let j=-range;j<=range;j++){
                let xt=x+i;
                let yt=y+j;
                if((i||j)&&verify(xt,yt))
                    func(xt,yt,this.get(xt,yt));
            }
        }
    },
    forRange(func,x,y,range=1){
        let xt,yt;
        for(let i=-range;i<=range;i++){
            let j = range;
            xt=x+i;
            yt=y+j;
            if(verify(xt,yt))
                func(xt,yt,this.get(xt,yt));
                
            j = -range;
            xt=x+i;
            yt=y+j;
            if(verify(xt,yt))
                func(xt,yt,this.get(xt,yt));
        }
        
        for(let j=-range+1;j<range;j++){
            let i = range;
            xt=x+i;
            yt=y+j;
            if(verify(xt,yt))
                func(xt,yt,this.get(xt,yt));
                
            i = -range;
            xt=x+i;
            yt=y+j;
            if(verify(xt,yt))
                func(xt,yt,this.get(xt,yt));
        }
    },
    forBorder(func,range=1){
        for(let y = 0; y < 50; y++) {
            func(0,y,this.get(0,y));
            func(49,y,this.get(49,y));
        }
        for(let x = 1; x < 49; x++) {
            func(x,0,this.get(x,0));
            func(x,49,this.get(x,49));
        }
    },
    initRoomTerrain(roomName){
        if(!this.arr)
            this.arr = new Array(50*50);
        let terrain = new Room.Terrain(roomName);
        this.forEach((x,y)=> {
            let v = terrain.get(x,y);
            this.set(x,y, v==TERRAIN_MASK_WALL?0xff:v==TERRAIN_MASK_SWAMP?4:2);
        });
    }
};
class RoomArray$3 {
    constructor(){
        this.__proto__ = RoomArray_proto;
    }
}

class RoomArray$1 {
    constructor() {
        this.arr = new Array(50 * 50).fill(0); // 初始化时直接填充数组
    }
    // 核心操作方法
    exec(x, y, val) {
        const tmp = this.get(x, y);
        this.set(x, y, val);
        return tmp;
    }
    get(x, y) {
        return this.arr[x * 50 + y];
    }
    set(x, y, value) {
        this.arr[x * 50 + y] = value;
    }
    // 初始化/重置数组
    init() {
        this.arr.fill(0);
        return this;
    }
    // 调试输出
    print() {
        console.log(this.arr.toString());
    }
    // 遍历方法
    forEach(func) {
        for (let y = 0; y < 50; y++) {
            for (let x = 0; x < 50; x++) {
                func(x, y, this.get(x, y));
            }
        }
    }
    // 四方向遍历
    for4Direction(func, x, y) {
        const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (const [dx, dy] of directions) {
            const xt = x + dx;
            const yt = y + dy;
            if (xt >= 0 && yt >= 0 && xt < 50 && yt < 50) {
                func(xt, yt, this.get(xt, yt));
            }
        }
    }
    // 周围范围遍历
    forNear(func, x, y, range = 1) {
        for (let i = -range; i <= range; i++) {
            for (let j = -range; j <= range; j++) {
                if (i === 0 && j === 0)
                    continue; // 跳过自身
                const xt = x + i;
                const yt = y + j;
                if (xt >= 0 && yt >= 0 && xt < 50 && yt < 50) {
                    func(xt, yt, this.get(xt, yt));
                }
            }
        }
    }
    // 边界遍历
    forBorder(func) {
        // 左右边界
        for (let y = 0; y < 50; y++) {
            func(0, y, this.get(0, y));
            func(49, y, this.get(49, y));
        }
        // 上下边界（排除角落已处理的部分）
        for (let x = 1; x < 49; x++) {
            func(x, 0, this.get(x, 0));
            func(x, 49, this.get(x, 49));
        }
    }
    // 地形初始化（假设在 Screeps 环境中）
    initRoomTerrainWalkAble(roomName) {
        const terrain = new Room.Terrain(roomName);
        this.forEach((x, y) => {
            const value = terrain.get(x, y);
            // 转换地形值：平地（0）-> 1，墙（1）-> 0，其他保持原值
            this.set(x, y, value === TERRAIN_MASK_WALL ? 0 : value === TERRAIN_MASK_SWAMP ? 2 : 1);
        });
    }
}

var RoomArray$2 = /*#__PURE__*/Object.freeze({
	__proto__: null,
	'default': RoomArray$1
});

var require$$2 = /*@__PURE__*/getAugmentedNamespace(RoomArray$2);

/**
 * 63超级扣位置自动布局
 * 能覆盖95% 地地形布局的覆盖
 *
 * author：6g3y,Scorpior,Scokranotes,ChenyangDu
 * version:1.0.8
 *
 * 【使用方法（傻瓜版）】
 * 1.设置4个flag，分别为对应房间的
 *     pc 控制器
 *     pm 矿
 *     pa pb 能量源
 * 2.下载63大佬的超级扣位置自动布局，解压并导入wasm二进制模块，
 *   命名（不要后缀）：algo_wasm_priorityqueue，确保此时文件夹中应当增了以下两个文件
 *     + 63_good.js
 *     + algo_wasm_priorityqueue.wasm
 *
 * 3.在主循环代码的末尾，也就是main.js的module.exports.loop中最后一行添加
 *      require("63超级扣位置自动布局_改良版").run()
 *
 * 4.运行（注意截图）
 * 5.放一个flag名字为p，随便放哪，运行会自动检测，检测到有p这个flag就会运行，运行完成会自动删掉
 *   显示的时间非常短，注意截图，消失了再放一个p又会重新运行一遍，不要反复折腾完，很耗CPU
 *
 * 【使用方法（高级版）】
 * 1.计算位置
 *  [flagController,flagMineral,flagSourceA,flagSourceB]
 *  必须包含.pos对象 {{{ p.pos.x|y }}}
 * >> roomStructsData = ManagerPlanner.computeManor(p.pos.roomName,[pc,pm,pa,pb])
 *
 * 2.可视化显示
 * >> HelperVisual.showRoomStructures(roomStructsData.roomName,roomStructsData.structMap)
 *
 * 【结果说明】
 * {
 *       roomName: roomName
 *       storagePos: {x,y} //storage集群中心位置
 *       labPos: {x,y} //lab中心位置
 *       structMap:{ "rampart" : [[x1,y1],[x2,y2] ...] ...}
 *           "建筑类型，直接用没问题的":[[x1,y1]]
 *           //建造的时候按顺序就可以了 ，顺序是距离 storagePos 排序过后的（除了road）
 *           //具体建造多少个，使用 CONTROLLER_STRUCTURES 获取当前可以造多少
 * }
 *
 *
 * 【警告】
 * ！！警告！！ 确保你的bucket和可运行CPU超过100个 ！！警告！！
 * ！！警告！！ 确保你的bucket和可运行CPU超过100个 ！！警告！！
 * ！！警告！！ 确保你的bucket和可运行CPU超过100个 ！！警告！！
 * ！！警告！！ 确保你的bucket和可运行CPU超过100个 ！！警告！！
 * ！！警告！！ 确保你的bucket和可运行CPU超过100个 ！！警告！！
 * ！！警告！！ 确保你的bucket和可运行CPU超过100个 ！！警告！！
 *
 *
 * 【原理】：能跑就行有空 写篇简书
 * 【代码】：挺乱的 如果有机会在整理一下代码
 *
 * 【更新说明】：
 * 1.优化了外矿的寻路
 * 2.优化了塔的布局
 * 3.更新了说明文档
 *
 * 感谢63！
 *
 */

/**
 *  wasm 优先队列
 *  帮你加速涉及优先级的调度算法
 *
 *  author: Scorpior
 *  version: v1.1.0
 *
 *  usage:
 *  1. add .js and .wasm modules
 *  2. require .js module and use
 *
 *  本人有改动！
 */
// @ts-ignore
const binary = require$$0__default["default"];
const _$1 = require$$1__default["default"];   // 读取二进制文件
const wasmModule = new WebAssembly.Module(binary);  // 初始化为wasm类
const RoomArray = require$$2.default; // CommonJS 语法

commonjsGlobal.structuresShape = {
    "spawn": "◎",
    "extension": "ⓔ",
    "link": "◈",
    "road": "•",
    "constructedWall": "▓",
    "rampart": "⊙",
    "storage": "▤",
    "tower": "🔫",
    "observer": "👀",
    "powerSpawn": "❂",
    "extractor": "⇌",
    "terminal": "✡",
    "lab": "☢",
    "container": "□",
    "nuker": "▲",
    "factory": "☭"
};
commonjsGlobal.structuresColor = {
    "spawn": "cyan",
    "extension": "#0bb118",
    "link": "yellow",
    "road": "#fa6f6f",
    "constructedWall": "#003fff",
    "rampart": "#003fff",
    "storage": "yellow",
    "tower": "cyan",
    "observer": "yellow",
    "powerSpawn": "cyan",
    "extractor": "cyan",
    "terminal": "yellow",
    "lab": "#d500ff",
    "container": "yellow",
    "nuker": "cyan",
    "factory": "yellow"
};

let helpervisual;
helpervisual = {
    //线性同余随机数
    rnd: function (seed) {
        return (seed * 9301 + 49297) % 233280; //为何使用这三个数?
    },
    // seed 的随机颜色
    randomColor: function (seed) {
        seed = parseInt(seed);
        let str = "12334567890ABCDEF";
        let out = "#";
        for (let i = 0; i < 6; i++) {
            seed = helpervisual.rnd(seed + Game.time % 100);
            out += str[parseInt(seed) % str.length];
        }
        return out
    },
    // 大概消耗1 CPU！ 慎用！
    showRoomStructures: function (roomName, structMap) {
        let roomStructs = new RoomArray();
        roomStructs.init();
        const visual = new RoomVisual(roomName);
        structMap["road"].forEach(e => roomStructs.set(e[0], e[1], "road"));
        _$1.keys(CONTROLLER_STRUCTURES).forEach(struct => {
            if (struct === "road") {
                structMap[struct].forEach(e => {
                    roomStructs.forNear((x, y, val) => {
                        if (val === "road" && ((e[0] >= x && e[1] >= y) || (e[0] > x && e[1] < y))) visual.line(x, y, e[0], e[1], {color: structuresColor[struct]});
                    }, e[0], e[1]);
                    visual.text(structuresShape[struct], e[0], e[1] + 0.25, {
                        color: structuresColor[struct],
                        opacity: 0.75,
                        fontSize: 7
                    });
                });
            } else structMap[struct].forEach(e => visual.text(structuresShape[struct], e[0], e[1] + 0.25, {
                color: structuresColor[struct],
                opacity: 0.75,
                fontSize: 7
            }));
        });
    },
};

commonjsGlobal.HelperVisual = helpervisual;


class UnionFind {

    constructor(size) {
        this.size = size;
    }

    init() {
        if (!this.parent)
            this.parent = new Array(this.size);
        for (let i = 0; i < this.size; i++) {
            this.parent[i] = i;
        }
    }

    find(x) {
        let r = x;
        while (this.parent[r] !== r) r = this.parent[r];
        while (this.parent[x] !== x) {
            let t = this.parent[x];
            this.parent[x] = r;
            x = t;
        }
        return x;
    }

    union(a, b) {
        a = this.find(a);
        b = this.find(b);
        if (a > b) this.parent[a] = b;
        else if (a !== b) this.parent[b] = a;
    }

    same(a, b) {
        return this.find(a) === this.find(b)
    }
}


commonjsGlobal.UnionFind = UnionFind;

let NodeCache = [];

function NewNode(k, x, y, v) {
    let t;
    if (NodeCache.length) {
        t = NodeCache.pop();
    } else {
        t = {};
    }
    t.k = k;
    t.x = x;
    t.y = y;
    t.v = v;
    return t
}


function ReclaimNode(node) {
    if (NodeCache.length < 10000)
        NodeCache.push(node);
}


/**
 *
 * @typedef {Object} node
 * @property {number} k 优先级实数（可负）
 *
 * @typedef {{
 *      memory:{
 *          buffer: ArrayBuffer
 *      },
 *      init(is_min:number):void,
 *      push(priorty:number, id:number):void,
 *      pop():void,
 *      top():number,
 *      get_identifier(pointer:number):number,
 *      size():number,
 *      clear():void,
 *      is_empty():boolean
 *  }} cppQueue
 */

class BaseQueue {

    /**
     * 队列元素个数
     * @returns {number}
     */
    size() {
        // @ts-ignore
        return this.instance.size();
    }

    /**
     * 清空整个队列
     */
    clear() {
        // @ts-ignore
        this.instance.clear();
    }

    /**
     * 队列是否为空
     * @returns {boolean} 实际返回值是0或1
     */
    isEmpty() {
        // @ts-ignore
        return !this.instance.is_empty();
    }
}

/**
 *  c++优先队列
 *  最大容量 131072 个元素（2的17次方）
 *  每个元素是带有priority属性的任意对象
 *  连续pop 100k个元素时比js队列快 80% 以上，元素个数少时比js快 5~10 倍
 */
class PriorityQueue extends BaseQueue {
    /**
     * @param {boolean} isMinRoot 优先级方向，true则pop()时得到数字最小的，否则pop()出最大的
     */
    constructor(isMinRoot = false) {
        super();
        /**@type {cppQueue} */
        let instance;
        /**@type {node[]} */
        let cache = [];

        const imports = {   // 把wasm类实例化需要的接口函数
            env: {
                emscripten_notify_memory_growth() {
                }
            },
            wasi_snapshot_preview1: {
                proc_exit: () => {
                }
            }
        };
        // @ts-ignore
        instance = new WebAssembly.Instance(wasmModule, imports).exports;   // 实例化
        instance.init(+!!isMinRoot);  // !!转化为boolean, +转为数字

        /**
         * @param {node} node
         */
        this.push = (node) => {
            try {
                instance.push(node.k, cache.length);
                cache.push(node);
            } catch (e) {
                if (e instanceof TypeError) {
                    throw e;
                } else {
                    throw Error(`priorityQueue is full.\n\t Current size is ${instance.size()}, buffer length is ${instance.memory.buffer.byteLength * 2 / 1024}KB.`);
                }
            }
        };
        /**
         *  @returns {node|undefined}
         */
        this.pop = () => {
            if (instance.size() > 0) {
                let pointer = instance.top();
                let id = instance.get_identifier(pointer);
                let node = cache[id];
                instance.pop();
                // @ts-ignore
                cache[id] = undefined;
                return node;
            } else {
                return undefined;
            }
        };
        /**
         *  @returns {node|undefined}
         */
        this.top = () => {
            if (instance.size() > 0) {
                let pointer = instance.top();
                return cache[instance.get_identifier(pointer)];
            } else {
                return undefined;
            }
        };
        /**
         *  @returns {undefined}
         */
        this.whileNoEmpty = (func) => {
            while (!this.isEmpty()) {
                let node = this.pop();
                func(node);
                ReclaimNode(node);
            }
        };

        Object.defineProperty(this, 'instance', {   // 不想被枚举到
            value: instance
        });
    }

    /**
     *  把节点插入队列
     * @param {node} node 待插入对象，至少含有priority:k属性
     */
    push(node) {
    }

    /**
     *  查看顶端节点，空队列返回undefined
     *  @returns {node|undefined}
     */
    top() {
    }

    /**
     *  取出顶端节点，空队列返回undefined
     *  @returns {node|undefined}
     */
    pop() {
    }
}

commonjsGlobal.PriorityQueue = PriorityQueue;
commonjsGlobal.NewNode = NewNode;
commonjsGlobal.ReclaimNode = ReclaimNode;
// module.exports = {
//     PriorityQueue: PriorityQueue
// }


commonjsGlobal.minPlaneCnt = 140; // 内部布局最小面积！ 试过了，140是 基本上最低配置了

let visited = new RoomArray();
let roomWalkable = new RoomArray();
let nearWall = new RoomArray();
let routeDistance = new RoomArray();
let roomObjectCache = new RoomArray();

let nearWallWithInterpolation = new RoomArray();
let interpolation = new RoomArray();

let queMin = new PriorityQueue(true);
let queMin2 = new PriorityQueue(true);
let startPoint = new PriorityQueue(true);

let unionFind = new UnionFind(50 * 50);

/**
 * controller mineral source posList
 */
let objects = [];

let pro = {
    /**
     * https://www.bookstack.cn/read/node-in-debugging/2.2heapdump.md
     * 防止内存泄漏！！！！
     * 闭包太多，改不动了
     */
    init() {
        visited = new RoomArray();
        roomWalkable = new RoomArray();
        nearWall = new RoomArray();
        routeDistance = new RoomArray();

        nearWallWithInterpolation = new RoomArray();
        interpolation = new RoomArray();
        roomObjectCache = new RoomArray();

        queMin = new PriorityQueue(true);
        queMin2 = new PriorityQueue(true);
        startPoint = new PriorityQueue(true);

        unionFind = new UnionFind(50 * 50);


        visited.init();
        nearWall.init();
        routeDistance.init();
        roomWalkable.init();

        nearWallWithInterpolation.init();
        interpolation.init();
        roomObjectCache.init();
        unionFind.init();

        queMin.clear();
        queMin2.clear();
        startPoint.clear();
    },
    /**
     * 防止内存泄漏！！！！
     */
    dismiss() {
        visited = null;
        roomWalkable = null;
        nearWall = null;
        routeDistance = null;
        roomObjectCache = null;

        nearWallWithInterpolation = null;
        interpolation = null;

        queMin = null;
        queMin2 = null;
        startPoint = null;

        unionFind = null;
        objects = [];
    },
    /**
     * 计算区块的最大性能指标 ，性能消耗的大头！
     * 优化不动了
     */
    getBlockPutAbleCnt(roomWalkable, visited, queMin, unionFind, tarRoot, putAbleCacheMap, AllCacheMap) {
        if (putAbleCacheMap[tarRoot]) return [putAbleCacheMap[tarRoot], AllCacheMap[tarRoot]]
        // let t = Game.cpu.getUsed() //这很吃性能，但是是必须的
        let roomManor = routeDistance;
        roomManor.init();
        roomManor.forEach((x, y) => {
            if (tarRoot === unionFind.find(x * 50 + y)) {
                roomManor.set(x, y, 1);
            }
        });
        //roomManor.print()
        roomManor.forEach((x, y, val) => {
            if (val) {
                let manorCnt = 0;
                let wallCnt = 0;
                roomManor.for4Direction((x1, y1, val1) => {
                    if (val1) manorCnt += 1;
                    if (!roomWalkable.get(x1, y1)) wallCnt += 1;
                }, x, y);
                if (manorCnt === 1 && wallCnt === 0) roomManor.set(x, y, 0);
            }
        });
        let dfsMoreManor = function (x, y, val) {
            if (!val && roomWalkable.get(x, y)) {
                let manorCnt = 0;
                let wallCnt = 0;
                roomManor.for4Direction((x1, y1, val1) => {
                    if (val1) manorCnt += 1;
                    if (!roomWalkable.get(x1, y1)) wallCnt += 1;
                }, x, y);
                if (manorCnt >= 2 || manorCnt === 1 && wallCnt >= 2) {
                    roomManor.set(x, y, 1);
                    roomManor.for4Direction((x1, y1, val1) => {
                        dfsMoreManor(x1, y1, val1);
                    }, x, y);
                }
            }
        };
        roomManor.forEach((x, y, val) => {
            dfsMoreManor(x, y, val);
        });
        roomWalkable.forBorder((x, y, val) => {
            if (val) {
                roomManor.forNear((x, y) => {
                    roomManor.set(x, y, 0);
                }, x, y);
                roomManor.set(x, y, 0);
            }
        });

        let innerPutAbleList = [];
        let AllCacheList = [];


        // &&!roomObjectCache.get(x,y)
        visited.init();/*
        roomWalkable.forEach((x, y, val)=>{
            if(!roomManor.get(x,y)||roomObjectCache.get(x,y)) {
                // const visual = new RoomVisual("W3N6");
                // if(roomObjectCache.get(x,y))visual.text(val&&!roomObjectCache.get(x,y)?-4:-1, x,y+0.25, {color: 'red',opacity:0.99,font: 7})
                // queMin.push(NewNode(val&&!roomObjectCache.get(x,y)?-4:-1,x,y));
                let innerWall = false //在墙上的时候要退一格子
                if(roomObjectCache.get(x,y)){
                    roomManor.forNear((x,y,val)=>{if(!val&&roomWalkable.get(x,y))innerWall=true},x,y)
                }
                queMin.push(NewNode(val?((roomObjectCache.get(x,y)&&!innerWall)?-1:-4):-1,x,y));
                // visited.set(x,y,1) 这里不能设置visited 因为 -4 和-1 优先级不同 如果 -4距离和-1比较，-1会抢走-4 导致 rangeAttack打得到
            }
        })*/

        roomWalkable.forEach((x, y, val) => {
            if (!roomManor.get(x, y)) {
                queMin.push(NewNode(val ? -4 : -1, x, y));
                // visited.set(x,y,1) 这里不能设置visited 因为 -4 和-1 优先级不同 如果 -4距离和-1比较，-1会抢走-4 导致 rangeAttack打得到
            }
        });

        // let t = Game.cpu.getUsed() //这很吃性能，真的优化不动了

        queMin.whileNoEmpty(nd => {
            let func = function (x, y, val) {
                let item = NewNode(nd.k + 2, x, y);
                if (!visited.exec(x, y, 1)) {
                    queMin.push(NewNode(nd.k + 1, x, y));
                    if (roomManor.get(x, y)) {
                        if (nd.k + 1 >= 0 && val) {
                            innerPutAbleList.push(item);
                            // visual.text(nd.k+2, x,y+0.25, {color: 'red',opacity:0.99,font: 7})
                        }
                        if (val)
                            AllCacheList.push(item);
                    }
                }
            };
            visited.set(nd.x, nd.y, 1);
            if (nd.k >= -1)
                roomWalkable.for4Direction(func, nd.x, nd.y);
            else
                roomWalkable.forNear(func, nd.x, nd.y);
        });

        // console.log(Game.cpu.getUsed()-t)

        putAbleCacheMap[tarRoot] = innerPutAbleList;
        AllCacheMap[tarRoot] = AllCacheList;
        return [putAbleCacheMap[tarRoot], AllCacheMap[tarRoot]]
    },
    /**
     * 插值，计算区块的预处理和合并需求
     * @param roomName
     */
    computeBlock(roomName) {
        const visual = new RoomVisual(roomName);

        roomWalkable.initRoomTerrainWalkAble(roomName);
        //计算距离山体要多远
        roomWalkable.forEach((x, y, val) => {
            if (!val) {
                queMin.push(NewNode(0, x, y));
                visited.set(x, y, 1);
            }
        });


        queMin.whileNoEmpty(nd => {
            //数字打印
            //visual.text(Math.floor(nd.k), nd.x,nd.y+0.25, {color: "white",opacity:0.75,fontSize: 7})
            //颜色打印
            //{if(nd.k>0)visual.circle(nd.x, nd.y, {fill: "#ff9797", radius: 0.5 ,opacity : 0.05*nd.k+0.01})}

            roomWalkable.for4Direction((x, y, val) => {
                if (!visited.exec(x, y, 1) && val) {
                    queMin.push(NewNode(nd.k + 1, x, y));
                }
            }, nd.x, nd.y);
            nearWall.exec(nd.x, nd.y, nd.k);
        });

        //距离出口一格不能放墙
        roomWalkable.forBorder((x, y, val) => {
            if (val) {
                roomWalkable.forNear((x, y, val) => {
                    if (val) {
                        // roomWalkable.set(x,y,0);
                        nearWall.set(x, y, 50);
                        queMin.push(NewNode(0, x, y));
                        // visited.set(x,y,1)
                    }
                }, x, y);
                // roomWalkable.set(x,y,0);
                queMin.push(NewNode(0, x, y));
                nearWall.set(x, y, 50);
                // visited.set(x,y,1)
            }
        });

        // 颜色
        //nearWall.forEach((x, y, val)=>{if(val>0)visual.circle(x, y, {fill: "#ff9797", radius: 0.5 ,opacity : 0.05*val+0.01})})
        //数字
        //nearWall.forEach((x, y, val)=>visual.text(Math.floor(val), x,y+0.25, {color: "white",opacity:0.75,fontSize: 7}))

        let roomPutAble = routeDistance;
        roomPutAble.initRoomTerrainWalkAble(roomName);
        roomWalkable.forBorder((x, y, val) => {
            if (val) {
                roomWalkable.forNear((x, y, val) => {
                    if (val) {
                        roomPutAble.set(x, y, 0);
                    }
                }, x, y);
                roomPutAble.set(x, y, 0);
            }
        });
        // 计算 控制器，矿物的位置
        let getObjectPos = function (x, y, struct) {
            let put = false;
            let finalX = 0;
            let finalY = 0;
            roomPutAble.for4Direction((x, y, val) => {
                if (val && !put && !roomObjectCache.get(x, y)) {
                    finalX = x;
                    finalY = y;
                    put = true;
                }
            }, x, y);
            roomPutAble.forNear((x, y, val) => {
                if (val && !put && !roomObjectCache.get(x, y)) {
                    finalX = x;
                    finalY = y;
                    put = true;
                }
            }, x, y);
            roomObjectCache.set(finalX, finalY, struct);
            return [finalX, finalY]
        };
        for (let i = 0; i < objects.length; i++) {
            let pos = objects[i];
            //container 位置
            let p = getObjectPos(pos.x, pos.y, "container");

            // link 位置
            if (i !== 1) {
                let linkPos = getObjectPos(p[0], p[1], "link");
                roomObjectCache.link = roomObjectCache.link || [];
                roomObjectCache.link.push(linkPos); // link controller 然后是  source
            } else {
                roomObjectCache.extractor = [[pos.x, pos.y]];
            }
            roomObjectCache.container = roomObjectCache.container || [];
            if (i !== 1) roomObjectCache.container.unshift(p); //如果是 mineral 最后一个
            else roomObjectCache.container.push(p);
        }

        //插值，这里用拉普拉斯矩阵，对nearWall 插值 成 nearWallWithInterpolation
        nearWall.forEach((x, y, val) => {
            let value = -4 * val;
            nearWall.for4Direction((x, y, val) => {
                value += val;
            }, x, y);
            interpolation.set(x, y, value);
            if (value > 0) value = 0;
            if (val && roomWalkable.get(x, y)) nearWallWithInterpolation.set(x, y, val + value * 0.1);
        });

        // 计算距离出口多远
        visited.init();
        routeDistance.init();
        queMin.whileNoEmpty(nd => {
            roomWalkable.forNear((x, y, val) => {
                if (!visited.exec(x, y, 1) && val) {
                    queMin.push(NewNode(nd.k + 1, x, y));
                }
            }, nd.x, nd.y);
            routeDistance.set(nd.x, nd.y, nd.k);
        });
        // 颜色
        //routeDistance.forEach((x, y, val)=>{if(val>0)visual.circle(x, y, {fill: "#ff9797", radius: 0.5 ,opacity : 0.01*val+0.01})})
        //数字
        // routeDistance.forEach((x, y, val) => visual.text(Math.floor(val), x, y + 0.25, {
        //     color: "white",
        //     opacity: 0.75,
        //     fontSize: 7
        // }))
        // 对距离的格子插入到队列 ，作为分开的顺序
        routeDistance.forEach((x, y, val) => {
            if (!roomWalkable.get(x, y)) return
            if (val) startPoint.push(NewNode(-val, x, y));
            //数字打印
            //visual.text(Math.floor(val), x,y+0.25, {color: "white",opacity:0.75,fontSize: 7})
            //颜色打印
            //visual.circle(x, y, {fill: "#ff9797", radius: 0.5 ,opacity : 0.02*val+0.10})
        });


        let sizeMap = {};
        let posSeqMap = {};

        // console.log("startPointSize:"+startPoint.size())
        // console.log("walkCount:"+walkCount)
        // console.log("noWalkCount"+noWalkCount)

        // 颜色
        // nearWallWithInterpolation.forEach((x, y, val) => {
        //     if (val > 0) visual.circle(x, y, {fill: "#ff9797", radius: 0.5, opacity: 0.01 * val + 0.01})
        // })
        //数字
        // nearWallWithInterpolation.forEach((x, y, val) => visual.text(Math.floor(val), x, y + 0.25, {
        //     color: "white",
        //     opacity: 0.75,
        //     fontSize: 7
        // }))

        // 分块，将地图分成一小块一小块
        visited.init();
        let index = 0;
        while (!startPoint.isEmpty()) {
            index++;
            let cnt = 0;//有意义的visited才有cnt的值
            let nd = startPoint.pop();
            if(index === 1)
            {
                visual.circle(nd.x, nd.y, {fill: "#ffffffff", radius: 0.5, opacity: 0.5});
            }
            //visual.circle(nd.x, nd.y, {fill: "#ff9797", radius: 0.5, opacity: 0.05 * -nd.k + 0.01})
            //visual.text(Math.floor(nd.k), nd.x,nd.y+0.25, {color: "white",opacity:0.75,fontSize: 7})
            let currentPos = nd.x * 50 + nd.y;
            let posSeq = [];

            //搜索分块
            let dfsFindDown = function (roomArray, x, y) {
                if (!visited.exec(x, y, 1)) {
                    let currentValue = roomArray.get(x, y);
                    roomArray.for4Direction((x1, y1, val) => {
                        if (val && (x1 === x || y1 === y) && val < currentValue) {
                            dfsFindDown(roomArray, x1, y1);
                        }
                    }, x, y);
                    cnt++;
                    //visual.circle(x,y, {fill: '#ff9797', radius: 0.5 ,opacity : 0.5})
                    //visual.text(currentValue, x,y+0.25, {color: "white",opacity:0.75,fontSize: 7})

                    let pos = x * 50 + y;
                    posSeq.push(pos);
                    unionFind.union(currentPos, pos);
                }
            };
            // 跑到最高点
            let dfsFindUp = function (roomArray, x, y) {
                if (!visited.exec(x, y, 1)) {
                    let currentValue = roomArray.get(x, y);
                    roomArray.forNear((x1, y1, val) => {
                        //visual.text(index, x,y+0.25, {color: "white",opacity:0.75,fontSize: 7})
                        //visual.circle(x1,y1, {fill: '#97ff97', radius: 0.5 ,opacity : 0.5*val})
                        //周围点的值大于当前点的值，并且，当前点的值小于6，对于小区块的优化(向上搜索)
                        if (val > currentValue && currentValue < 6) { //加了一点优化，小于时分裂更过
                            dfsFindUp(roomArray, x1, y1);
                        } // 周围点的值>0(非墙体) 并且周围点的值小于当前点的值(向下搜索)
                        else if (val && val < currentValue) {
                            dfsFindDown(roomArray, x1, y1);
                        }
                    }, x, y);
                    cnt++;
                    //visual.text((currentValue), x,y+0.25, {color: "white",opacity:0.75,fontSize: 3})
                    //visual.text(Math.floor(cnt), x,y+0.25, {color: "white",opacity:0.75,fontSize: 7})
                    //visual.circle(x,y, {fill: '#94ff5766', radius: 0.5 ,opacity : 0.5})
                    let pos = x * 50 + y;
                    posSeq.push(pos);
                    unionFind.union(currentPos, pos);
                }
            };
            dfsFindUp(nearWallWithInterpolation, nd.x, nd.y);

            //记录每一块的位置和大小 以 并查集的根节点 作为记录点
            if (cnt > 0) {
                let pos = unionFind.find(currentPos);
                //let randRomColor = helpervisual.randomColor(currentPos)
                // visual.text(Math.floor(cnt), nd.x,nd.y+0.25, {color: "white",opacity:0.75,fontSize: 7})
                // visual.circle(nd.x,nd.y, {fill: randRomColor, radius: 0.1 ,opacity : 1})
                // posSeq.forEach((pos) => {
                //     const posNum = Number(pos)
                //     let y = posNum % 50;
                //     let x = ((posNum - y) / 50);//Math.round
                //     visual.circle(x, y, {
                //         fill: randRomColor,
                //         radius: 0.5,
                //         opacity: 0.3 + 0.01
                //     })
                // })
                // queMin.push({k:cnt,v:pos})
                queMin.push(NewNode(cnt, 0, 0, pos));
                sizeMap[pos] = cnt;
                posSeqMap[pos] = posSeq;
            }
        }
        // Object.keys(posSeqMap).forEach(pos => {
        //     let randRomColor = helpervisual.randomColor(pos)
        //     posSeqMap[pos].forEach(e=>{            {
        //             let y = e % 50;
        //             let x = ((e - y) / 50);//Math.round
        //             visual.circle(x, y, {
        //                 fill: randRomColor,
        //                 radius: 0.5,
        //                 opacity: 0.3 + 0.01
        //             })
        //     }})
        //     //并查集根节点
        //     const posNum = Number(pos)
        //     let y = posNum % 50;
        //     let x = ((posNum - y) / 50);//Math.round
        //      visual.circle(x, y, {fill: "#ff9797", radius: 0.1, opacity: 1})
        //      visual.text(Math.floor(sizeMap[pos]), x,y+0.25, {color: "white",opacity:0.75,fontSize: 7})
        // })

        // 将出口附近的块删掉
        roomWalkable.forBorder((x, y, val) => {
            if (val) {
                roomWalkable.forNear((x, y, val) => {
                    if (val) {
                        let pos = unionFind.find(x * 50 + y);
                        if (sizeMap[pos]) delete sizeMap[pos];
                    }
                }, x, y);
                let pos = unionFind.find(x * 50 + y);
                if (sizeMap[pos]) delete sizeMap[pos];
            }
        });

        let putAbleCacheMap = {};
        let allCacheMap = {};
        // let i = 0
        // 合并小块成大块的
        queMin.whileNoEmpty(nd => {
            let pos = nd.v;
            if (nd.k !== sizeMap[pos]) return;// 已经被合并了
            // i++;

            visited.init();
            let nearCntMap = {};

            //搜索附近的块
            posSeqMap[pos].forEach(e => {
                let y = e % 50;
                let x = ((e - y) / 50);//Math.round
                roomWalkable.forNear((x, y, val) => {
                    if (val && !visited.exec(x, y, 1)) {
                        let currentPos = unionFind.find(x * 50 + y);
                        if (currentPos === pos) return;
                        // if(i==104)
                        // visual.text(parseInt(1*10)/10, x,y+0.25, {color: "cyan",opacity:0.99,font: 7})
                        let currentSize = sizeMap[currentPos];
                        if (currentSize < 300) {
                            nearCntMap[currentPos] = (nearCntMap[currentPos] || 0) + 1;
                        }
                    }
                }, x, y);
            });

            let targetPos = undefined;
            let nearCnt = 0;
            let maxRatio = 0;

            // 找出合并附近最优的块
            _$1.keys(nearCntMap).forEach(currentPos => {
                let currentRatio = nearCntMap[currentPos] / Math.sqrt(Math.min(sizeMap[currentPos], nd.k));//实际/期望
                if (currentRatio === maxRatio ? sizeMap[currentPos] < sizeMap[targetPos] : currentRatio > maxRatio) {
                    targetPos = currentPos;
                    maxRatio = currentRatio;
                    nearCnt = nearCntMap[currentPos];
                }
            });
            _$1.keys(nearCntMap).forEach(currentPos => {
                if (nearCnt < nearCntMap[currentPos]) {
                    targetPos = currentPos;
                    nearCnt = nearCntMap[currentPos];
                }
            });
            let minSize = sizeMap[targetPos];
            let cnt = nd.k + minSize;
            // let nearRatio =nearCntMap[targetPos]/allNearCnt;

            let targetBlockPutAbleCnt = 0;
            let ndkBlockPutAbleCnt = 0;
            if (minSize > minPlaneCnt)
                targetBlockPutAbleCnt = pro.getBlockPutAbleCnt(roomWalkable, visited, queMin2, unionFind, targetPos, putAbleCacheMap, allCacheMap)[0].length;
            if (nd.k > minPlaneCnt)
                ndkBlockPutAbleCnt = pro.getBlockPutAbleCnt(roomWalkable, visited, queMin2, unionFind, nd.v, putAbleCacheMap, allCacheMap)[0].length;

            //if(targetBlockPutAbleCnt||ndkBlockPutAbleCnt)clog(targetBlockPutAbleCnt,ndkBlockPutAbleCnt)
            //打印中间变量
            // if(targetPos&&cnt>50&&(targetBlockPutAbleCnt||ndkBlockPutAbleCnt)){
            //     let y = pos%50
            //     let x = Math.round((pos-y)/50)
            //     let y1 = targetPos%50
            //     let x1 = Math.round((targetPos-y1)/50)
            //     visual.line(x,y,x1,y1)
            //     visual.text(nd.k+"+"+minSize+"="+cnt, (x+x1)/2,(y+y1)/2-0.25, {color: "red",opacity:0.99,font: 7})
            //     visual.text(allNearCnt+"_"+nearCntMap[targetPos]+" "+nearCnt+" "+parseInt(nearCnt/Math.sqrt(Math.min(minSize,nd.k))*100)/100+" "+parseInt(maxRatio-Math.sqrt(nd.k)/12*100)/100, (x+x1)/2,(y+y1)/2+0.25, {color: "yellow",opacity:0.99,font: 7})
            //     visual.text(parseInt(targetBlockPutAbleCnt*100)/100+" "+parseInt(ndkBlockPutAbleCnt*100)/100, (x+x1)/2,(y+y1)/2+0.25, {color: "yellow",opacity:0.99,font: 7})
            // }

            // if(targetPos&&((cnt<=250&&maxRatio>0.7)||(cnt<=300&&maxRatio>0.8)||(cnt<=350&&maxRatio>0.9)||(maxRatio>1&&cnt<400)||nd.k<=10)){//||maxRatio>1.5
            // if(targetPos&&(maxRatio-cnt/500>0.2&&cnt<400)){//||maxRatio>1.5

            // cnt = targetBlockPutAbleCnt+ndkBlockPutAbleCnt;
            // 合并
            if (targetPos && Math.max(targetBlockPutAbleCnt, ndkBlockPutAbleCnt) < minPlaneCnt) {//&&(maxRatio-Math.sqrt(cnt)/20>=0||(nearRatio>0.7&&nd.k<100))
                // if(targetPos&&(cnt<300||Math.min(nd.k,minSize)<150)&&(maxRatio-Math.sqrt(cnt)/20>=0||Math.max(nd.k,minSize)<200||(nearRatio>0.7&&nd.k<100))){//*Math.sqrt(nearRatio)


                unionFind.union(pos, targetPos);
                nd.v = unionFind.find(pos);

                if (pos !== nd.v) delete sizeMap[pos];
                else delete sizeMap[targetPos];

                nd.k = cnt;
                sizeMap[nd.v] = cnt;
                posSeqMap[nd.v] = posSeqMap[targetPos].concat(posSeqMap[pos]);
                delete putAbleCacheMap[nd.v];
                delete putAbleCacheMap[targetPos];
                if (pos !== nd.v) delete posSeqMap[pos];
                else delete posSeqMap[targetPos];
                queMin.push(NewNode(nd.k, nd.x, nd.y, nd.v));
            }

        });
        // 打印结果

        // const visual = new RoomVisual(roomName);
        // _.keys(sizeMap).forEach(e=>{
        //     let y = e%50
        //     let x = ((e-y)/50)//Math.round
        //     let color = "red"
        //     let cnt = pro.getBlockPutAbleCnt(roomWalkable,visited,queMin2,unionFind,e,putAbleCacheMap).length
        //     pro.getBlockPutAbleCnt(roomWalkable,visited,queMin2,unionFind,e,putAbleCacheMap).forEach(t=>{
        //         visual.circle(t.x, t.y, {fill: randomColor(e), radius: 0.5 ,opacity : 0.35})
        //     })
        //     // let cnt = sizeMap[e]
        //     if(sizeMap[e]>0)visual.text(parseInt(cnt*10)/10, x,y+0.25, {color: color,opacity:0.99,font: 7})
        // })

        //块打印
        // roomWalkable.forEach((x, y, val) => {
        //     if (val > 0 && sizeMap[unionFind.find(x * 50 + y)] > 0)
        //         visual.circle(x, y, {
        //                 fill: helpervisual.randomColor(unionFind.find(x * 50 + y)),
        //                 radius: 0.5,
        //                 opacity: 0.15
        //             }
        //         )
        // })


        // 打印中间变量
        // 颜色
        //nearWallWithInterpolation.forEach((x, y, val)=>{if(val>0)visual.circle(x, y, {fill: "#ff9797", radius: 0.5 ,opacity : 0.05*val+0.01})})
        //数字
        //nearWallWithInterpolation.forEach((x, y, val)=>visual.text(Math.floor(val), x,y+0.25, {color: "white",opacity:0.75,fontSize: 7}))

        //nearWall.forEach((x, y, val)=>{if(val)visual.text(parseInt(val*10)/10, x,y+0.25, {color: "red",opacity:0.5,font: 7})})

        return [unionFind, sizeMap, roomWalkable, nearWall, putAbleCacheMap, allCacheMap]

    },
    /**
     * 计算 分布图
     * 计算建筑的位置
     * @param roomName 房间名称
     * @param points[] [flagController,flagMineral,flagSourceA,flagSourceB]
     * @return result { roomName:roomName,storagePos:{x,y},labPos:{x,y},structMap:{ "rampart" : [[x1,y1],[x2,y2] ...] ...} }
     */
    computeManor(roomName, points) {
        pro.init();
        for (let p of points) {
            if (p.pos && p.pos.roomName === roomName) objects.push(p.pos);
        }
        new RoomVisual(roomName);
        //计算块
        let blockArray = pro.computeBlock(roomName);

        let unionFind = blockArray[0];
        let sizeMap = blockArray[1];
        let wallMap = {};
        let roomWalkable = blockArray[2];
        let nearWall = blockArray[3];
        let putAbleCacheMap = blockArray[4];
        let allCacheMap = blockArray[5];

        let roomManor = interpolation;
        let roomStructs = nearWallWithInterpolation;


        roomManor.init();
        roomStructs.init();

        // let closeToWall = new RoomArray()
        nearWall.init();

        // let queMin = new PriorityQueue(true)
        queMin.clear();
        // let visited = new RoomArray()

        let finalPos = undefined;
        let wallCnt = 1e9;
        let innerPutAbleList = [];

        let centerX = undefined;
        let centerY = undefined;
        _$1.keys(sizeMap).forEach(pos => {
            // if(sizeMap[pos]<150)return
            pro.getBlockPutAbleCnt(roomWalkable, visited, queMin, unionFind, pos, putAbleCacheMap, allCacheMap);
            let currentPutAbleList = putAbleCacheMap[pos];
            let allList = allCacheMap[pos];
            if (currentPutAbleList.length < minPlaneCnt) return

            wallMap[pos] = [];

            visited.init();
            roomWalkable.forBorder((x, y, val) => {
                if (val) {
                    queMin.push(NewNode(0, x, y));
                    visited.set(x, y, 1);
                }
            });

            let roomManor = routeDistance; //当前的Manor
            roomManor.init();
            allList.forEach(e => {
                roomManor.set(e.x, e.y, 1);
            });
            // currentPutAbleList.forEach(e=>visual.text(e.k, e.x,e.y+0.25, {color: 'red',opacity:0.99,font: 7}))

            queMin.whileNoEmpty(nd => {
                if (!roomManor.get(nd.x, nd.y))
                    roomWalkable.forNear((x, y, val) => {
                        if (!visited.exec(x, y, 1) && val) {
                            if (!roomManor.get(x, y))
                                queMin.push(NewNode(nd.k + 1, x, y));
                            else {
                                wallMap[pos].push(NewNode(0, x, y));
                                // visual.text('X', x,y+0.25, {color: 'red',opacity:0.99,font: 7})
                            }
                        }
                    }, nd.x, nd.y);
            });

            // wallMap[pos].forEach(xy=>queMin.push(NewNode(0,xy.x,xy.y)))

            let currentInnerPutAbleList = currentPutAbleList;

            let maxDist = 0;
            let filter2 = currentInnerPutAbleList.filter(e => e.k > 2);
            if (filter2.length < 30) {
                filter2.forEach(a => {
                    filter2.forEach(b => {
                        maxDist = Math.max(maxDist, Math.abs(a.x - b.x) + Math.abs(a.y - b.y));
                    });
                });
            }

            let currentWallCnt = wallMap[pos].length;
            // {
            //     let y = pos%50
            //     let x = ((pos-y)/50)//Math.round
            //     visual.text(parseInt((allList.length)*10)/10, x,y, {color: "yellow",opacity:0.99,font: 7})
            //     visual.text(parseInt((currentPutAbleList.length)*10)/10, x,y+0.5, {color: "red",opacity:0.99,font: 7})
            //     visual.text(parseInt((currentInnerPutAbleList.length)*10)/10, x,y+1, {color: "red",opacity:0.99,font: 7})
            // }
            if (minPlaneCnt < currentPutAbleList.length && wallCnt > currentWallCnt && (currentInnerPutAbleList.filter(e => e.k > 1).length > 30 || maxDist > 5)) {
                innerPutAbleList = currentInnerPutAbleList;
                wallCnt = currentWallCnt;
                finalPos = pos;
                centerX = currentPutAbleList.map(e => e.x).reduce((a, b) => a + b) / currentPutAbleList.length;
                centerY = currentPutAbleList.map(e => e.y).reduce((a, b) => a + b) / currentPutAbleList.length;
            }

            // allCacheMap[pos].forEach(t=>{
            //     visual.circle(t.x, t.y, {fill: randomColor(pos), radius: 0.5 ,opacity : 0.15})
            // })
        });

        if (!putAbleCacheMap[finalPos])
            return

        let walls = wallMap[finalPos];


        roomManor.init();
        allCacheMap[finalPos].forEach(e => {
            roomManor.set(e.x, e.y, -1);
        });
        innerPutAbleList.forEach(e => {
            roomManor.set(e.x, e.y, e.k);
        });

        // visited.init()
        // roomWalkable.forEach((x, y, val)=>{if(!roomManor.get(x,y)){queMin.push(NewNode(val?-3:-1,x,y));visited.set(x,y,1)}})


        let storageX = 0;
        let storageY = 0;
        let storageDistance = 100;

        // innerPutAbleList.forEach(e=>visual.text(e.k, e.x,e.y+0.25, {color: 'red',opacity:0.99,font: 7}))
        innerPutAbleList.filter(e => e.k > 2).forEach(e => {
            let x = e.x;
            let y = e.y;
            let detX = centerX - x;
            let detY = centerY - y;
            let distance = Math.sqrt(detX * detX + detY * detY);
            if (storageDistance > distance) {
                storageDistance = distance;
                storageX = x;
                storageY = y;
            }
        });


        if (Game.flags.storagePos) {
            storageX = Game.flags.storagePos.pos.x;
            storageY = Game.flags.storagePos.pos.y;
        }

        let labX = 0;
        let labY = 0;
        let labDistance = 1e5;
        innerPutAbleList.filter(e => e.k > 4).forEach(e => {
            let x = e.x;
            let y = e.y;
            let detX = centerX - x;
            let detY = centerY - y;
            let distance = Math.sqrt(detX * detX + detY * detY);

            if (labDistance > distance && Math.abs(x - storageX) + Math.abs(y - storageY) > 5) {
                labDistance = distance;
                labX = x;
                labY = y;
            }
        });

        roomManor.forEach((x, y, val) => {
            if (val >= 2) {
                // if(roomManor.get(x,y)>0&&Math.abs(x-storageX)+Math.abs(y-storageY)>2)
                // visual.text(val, x,y+0.25, {color: 'cyan',opacity:0.99,font: 7})
                let distance = Math.sqrt(Math.pow(centerX - x - 0.5, 2) + Math.pow(centerY - y - 0.5, 2));
                if (labDistance <= distance) return;
                let checkCnt = 0;
                let check = function (x, y) {
                    if (roomManor.get(x, y) > 0 && Math.abs(x - storageX) + Math.abs(y - storageY) > 2) {
                        checkCnt += 1;
                    }
                };
                for (let i = -1; i < 3; i++)
                    for (let j = -1; j < 3; j++)
                        check(x + i, y + j);
                if (checkCnt === 16) {
                    labDistance = distance;
                    labX = x;
                    labY = y;
                }
            }
        });


        // visual.text("C", centerX,centerY+0.25, {color: 'green',opacity:0.99,font: 7})
        // visual.text("S", storageX,storageY+0.25, {color: 'blue',opacity:0.99,font: 7})
        // visual.text("L", labX+0.5,labY+0.75, {color: 'blue',opacity:0.99,font: 7})
        // clog(roomName)

        // clog(roomName,storageX,storageY,labX,labY,innerPutAbleList.length,wallCnt,finalPos)
        // clog(innerPutAbleList.filter(e=>e.k==1).length)

        // _.keys(sizeMap).forEach(e=>{
        //     let y = e%50
        //     let x = ((e-y)/50)//Math.round
        //     let color = "red"
        //     if(sizeMap[e]>0)visual.text(parseInt(sizeMap[e]*10)/10, x,y+1+0.25, {color: color,opacity:0.99,font: 7})
        // })

        // CONTROLLER_STRUCTURES: {
        //     "spawn": {0: 0, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 2, 8: 3},
        //     "extension": {0: 0, 1: 0, 2: 5, 3: 10, 4: 20, 5: 30, 6: 40, 7: 50, 8: 60},
        //     "link": {1: 0, 2: 0, 3: 0, 4: 0, 5: 2, 6: 3, 7: 4, 8: 6},
        //     "road": {0: 2500, 1: 2500, 2: 2500, 3: 2500, 4: 2500, 5: 2500, 6: 2500, 7: 2500, 8: 2500},
        //     "constructedWall": {1: 0, 2: 2500, 3: 2500, 4: 2500, 5: 2500, 6: 2500, 7: 2500, 8: 2500},
        //     "rampart": {1: 0, 2: 2500, 3: 2500, 4: 2500, 5: 2500, 6: 2500, 7: 2500, 8: 2500},
        //     "storage": {1: 0, 2: 0, 3: 0, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1},
        //     "tower": {1: 0, 2: 0, 3: 1, 4: 1, 5: 2, 6: 2, 7: 3, 8: 6},
        //     "observer": {1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 1},
        //     "powerSpawn": {1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 1},
        //     "extractor": {1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 1, 7: 1, 8: 1},
        //     "terminal": {1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 1, 7: 1, 8: 1},
        //     "lab": {1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 3, 7: 6, 8: 10},
        //     "container": {0: 5, 1: 5, 2: 5, 3: 5, 4: 5, 5: 5, 6: 5, 7: 5, 8: 5},
        //     "nuker": {1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 1},
        //     "factory": {1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 1, 8: 1}
        // }

        // nearWall.forEach((x, y, val)=>{if(val>2&&finalPos==unionFind.find(x*50+y))visual.text(nearWall.get(x,y),x, y+0.5, {color: "red",opacity:0.99,font: 7})})

        /**
         * 这里开始计算布局！
         * @type {{}}
         */
        let structMap = {};
        _$1.keys(CONTROLLER_STRUCTURES).forEach(e => structMap[e] = []);

        // 资源点布局
        structMap["link"] = roomObjectCache.link;
        structMap["container"] = roomObjectCache.container;
        structMap["extractor"] = roomObjectCache.extractor;
        //中心布局
        structMap["storage"].push([storageX - 1, storageY]);
        structMap["terminal"].push([storageX, storageY + 1]);
        structMap["factory"].push([storageX + 1, storageY]);
        structMap["link"].push([storageX, storageY - 1]);
        for (let i = -1; i <= 1; i++) {
            for (let j = -1; j <= 1; j++) {
                structMap["road"].push([storageX + i + j, storageY + i - j]); //仿射变换 [sin,cos,cos,-sin]
            }
        }
        // 这里修改lab布局
        let labs = [
            "☢☢-☢",
            "☢-☢-",
            "-☢-☢",
            "☢-☢☢"
            // "☢☢☢☢☢",
            // "-----",
            // "☢☢☢☢☢"
        ];
        let labChangeDirection = false;
        if ((storageX - labX) * (storageY - labY) < 0) {
            labChangeDirection = true;
        }

        let vis = {};
        for (let i = 0; i < 2; i++) {
            for (let j = 0; j < 2; j++) {
                vis[i + "_" + j] = 1; // 优先放置中间的label
                let jj = labChangeDirection ? j : 1 - j;
                let structs = labs[i + 1].charAt(j + 1);
                if (structs === '☢')
                    structMap["lab"].push([labX + i, labY + jj]);
                else
                    structMap["road"].push([labX + i, labY + jj]);
            }
        }

        for (let i = -1; i < 3; i++) {
            for (let j = -1; j < 3; j++) {
                if (vis[i + "_" + j]) continue;
                let jj = labChangeDirection ? j : 1 - j;
                let structs = labs[i + 1].charAt(j + 1);
                if (structs === '☢')
                    structMap["lab"].push([labX + i, labY + jj]);
                else
                    structMap["road"].push([labX + i, labY + jj]);
            }
        }

        walls.forEach(e => structMap["rampart"].push([e.x, e.y]));

        _$1.keys(CONTROLLER_STRUCTURES).forEach(struct => structMap[struct].forEach(e => roomStructs.set(e[0], e[1], struct)));

        structMap["road"].forEach(e => roomStructs.set(e[0], e[1], 1));
        //设置权值，bfs联通路径！
        let setModel = function (xx, yy) {
            let checkAble = (x, y) => (x >= 0 && y >= 0 && x <= 49 && y <= 49) && roomManor.get(x, y) > 0 && !roomStructs.get(x, y);
            for (let i = -1; i <= 1; i++) {
                for (let j = -1; j <= 1; j++) {
                    let x = xx + i + j;
                    let y = yy + i - j;
                    if (checkAble(x, y)) {
                        if (i || j) {
                            // structMap["road"] .push([x,y]) //仿射变换 [sin,cos,cos,-sin]
                            roomStructs.set(x, y, 1);
                        } else {
                            // structMap["spawn"] .push([x,y])
                            roomStructs.set(x, y, 12);
                        }
                    }
                }
            }
            for (let e of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                let x = xx + e[0];
                let y = yy + e[1];
                if (checkAble(x, y)) {
                    // structMap["extension"] .push([x,y])
                    roomStructs.set(x, y, 8);
                }
            }
        };

        for (let i = 0; i < 50; i += 4) {
            for (let j = 0; j < 50; j += 4) {
                let x = storageX % 4 + i;
                let y = storageY % 4 + j;
                setModel(x, y);
                setModel(x + 2, y + 2);

            }
        }
        visited.init();
        visited.set(storageX, storageY, 1);

        queMin.push(NewNode(1, storageX, storageY));
        let costRoad = routeDistance; //重复使用
        costRoad.init();
        queMin.whileNoEmpty(nd => {
            roomStructs.forNear((x, y, val) => {
                if (!visited.exec(x, y, 1) && val > 0) {
                    queMin.push(NewNode(nd.k + val, x, y));
                }
            }, nd.x, nd.y);
            costRoad.set(nd.x, nd.y, nd.k);
            // visual.text(nd.k,nd.x,nd.y+0.25, {color: "pink",opacity:0.99,font: 7})
        });

        structMap["road"].forEach(e => roomStructs.set(e[0], e[1], "road")); //这里把之前的road覆盖上去防止放在之前里road上了

        costRoad.forEach((x, y, val) => {
            if (!val) return;
            let minVal = 50;
            // let finalX = 0;
            // let finalY = 0;
            costRoad.forNear((x1, y1, val) => {
                if (minVal > val && val > 0) {
                    minVal = val;
                    // finalX = x1
                    // finalY = y1
                }
            }, x, y);
            // 方案2 没那么密集
            costRoad.forNear((x1, y1, val) => {
                if (minVal === val && val > 0) {
                    // structMap["road"].push([x1,y1])
                    roomStructs.set(x1, y1, "road");
                }
            }, x, y);
            // 方案1 密集
            // structMap["road"].push([finalX,finalY])
            // roomStructs.set(finalX,finalY,"road")
        });

        let spawnPos = [];
        let extensionPos = [];
        roomStructs.forEach((x, y, val) => {
            if (val > 0) {
                let dist = 100;
                costRoad.forNear((x, y, val) => {
                    if (val) dist = Math.min(dist, val);
                }, x, y);
                // let dist = Math.sqrt(Math.pow(x-storageX,2)+Math.pow(y-storageY,2))
                if (val === 12) {// 8 && 12 上面有写，注意！！！
                    spawnPos.push([x, y, dist]);
                } else {
                    extensionPos.push([x, y, dist]);
                    // visual.text(dist,x, y+0.25, {color: "pink",opacity:0.99,font: 7})
                }
            }
        });
        let cmpFunc = (a, b) => a[2] === b[2] ? (a[1] === b[1] ? a[0] - b[0] : a[1] - b[1]) : a[2] - b[2];
        spawnPos = spawnPos.sort(cmpFunc);
        extensionPos = extensionPos.sort(cmpFunc);
        let oriStruct = [];
        let putList = [];
        ["spawn", "powerSpawn", "nuker", "tower", "observer"].forEach(struct => {
            for (let i = 0; i < CONTROLLER_STRUCTURES[struct][8]; i++) {
                oriStruct.push(struct);
            }
        });
        oriStruct.forEach(struct => {
            let e = spawnPos.shift();
            if (!e) e = extensionPos.shift();
            structMap[struct].push([e[0], e[1]]);
            putList.push([e[0], e[1], struct]);
        });
        extensionPos.push(...spawnPos);
        extensionPos = extensionPos.sort(cmpFunc);
        let extCnt = 60;
        extensionPos.forEach(e => {
            if (extCnt > 0) {
                structMap["extension"].push([e[0], e[1]]);
                putList.push([e[0], e[1], "extension"]);
                extCnt -= 1;
            }
        });


        // 更新roads
        roomStructs.init();
        _$1.keys(CONTROLLER_STRUCTURES).forEach(struct => structMap[struct].forEach(e => roomStructs.set(e[0], e[1], struct)));
        visited.init();
        structMap["road"].forEach(e => visited.set(e[0], e[1], 1));
        /**
         * 更新最近的roads 但是可能有残缺
         */
        putList.forEach(e => {
            let x = e[0];
            let y = e[1];
            let minVal = 50;
            costRoad.forNear((x1, y1, val) => {
                if (minVal > val && val > 0) {
                    minVal = val;
                }
            }, x, y);
            // 方案2 没那么密集
            costRoad.forNear((x1, y1, val) => {
                if (minVal === val && val > 0) {
                    // 找到建筑最近的那个road
                    roomStructs.set(x1, y1, "road");
                }
            }, x, y);
        });
        /**
         * 再roads的基础上，对rads进行补全，将残缺的连起来
         */
        roomStructs.forEach((x, y, val) => {
            if (val === 'link' || val === 'container') return; // 资源点的不要 放路
            if (!val instanceof String || val > -1) return; // 附近有建筑 ，并且不是road
            // visual.text(val,x, y+0.25, {color: "pink",opacity:0.99,font: 7})
            let minVal = 50;
            costRoad.forNear((x1, y1, val) => {
                if (minVal > val && val > 0) {
                    minVal = val;
                }
            }, x, y);
            // 方案2 没那么密集
            costRoad.forNear((x1, y1, val) => {
                if (minVal === val && val > 0) {
                    // 找到建筑最近的那个road
                    if (!visited.exec(x1, y1, 1)) structMap["road"].push([x1, y1]);
                }
            }, x, y);
        });

        // 处理塔的位置，让塔尽量靠外
        let getRange = function (a, b) {
            return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]))
        };
        let poses = [];
        let types = ["nuker", "tower", "observer"];
        types.forEach(type => {
            structMap[type].forEach(e => {
                let dis = 0;
                structMap["rampart"].forEach(e_ramp => {
                    dis += getRange(e_ramp, e);
                });
                poses.push({pos: e, type, dis});
            });
        });
        poses.sort((a, b) => (a.dis - b.dis));

        for (let i = 0; i < 6; i++) {
            if (poses[i].type === "tower") continue;
            for (let j = 6; j < poses.length; j++) {
                if (poses[j].type !== "tower") continue;
                poses[j].type = poses[i].type;
                poses[i].type = "tower";
            }
        }
        types.forEach(type => {
            structMap[type] = [];
        });
        poses.forEach(pos => {
            structMap[pos.type].push(pos.pos);
        });

        //#region 新的连接外矿方式

        let costs = new PathFinder.CostMatrix;
        let terrain = new Room.Terrain(roomName);
        for (let i = 0; i < 50; i++) {
            for (let j = 0; j < 50; j++) {
                let te = terrain.get(i, j);
                costs.set(i, j, te === TERRAIN_MASK_WALL ? 255 : (te === TERRAIN_MASK_SWAMP ? 4 : 2));
            }
        }
        for (let struct of OBSTACLE_OBJECT_TYPES) {
            if (structMap[struct]) {
                structMap[struct].forEach(e => {
                    costs.set(e[0], e[1], 255);
                });
            }
        }
        structMap["road"].forEach(e => {
            costs.set(e[0], e[1], 1);
        });
        structMap["container"].forEach(e => {
            let ret = PathFinder.search(
                new RoomPosition(centerX, centerY, roomName),
                {pos: new RoomPosition(e[0], e[1], roomName), range: 1},
                {
                    roomCallback: () => {
                        return costs
                    },
                    maxRooms: 1
                }
            );
            ret.path.forEach(pos => {
                if (costs.get(pos.x, pos.y) !== 1) {
                    structMap['road'].push([pos.x, pos.y]);
                    costs.set(pos.x, pos.y, 1);
                }
            });

        });
        //#endregion

        //#region 旧的连接外矿道路

        // // 连接外矿的全部道路
        // _.keys(CONTROLLER_STRUCTURES).forEach(struct=>structMap[struct].forEach(e=>roomStructs.set(e[0],e[1],struct)))

        // costRoad.forEach((x,y,val)=>costRoad.set(x,y,100))//初始化100
        // visited.init()
        // queMin.push(NewNode(0,storageX,storageY))//以 storage为中心
        // visited.exec(storageX,storageY,1)
        // queMin.whileNoEmpty(nd=>{
        //     roomStructs.forNear((x,y,val)=>{
        //         let roadCost = roomWalkable.get(x,y);
        //         if(!visited.exec(x,y,1)&&(!val||val=='road'||val=='rampart')&&roadCost){
        //             queMin.push(NewNode(nd.k+(val=='road'?0:roadCost==2?4:2),x,y))
        //         }
        //     },nd.x,nd.y)
        //     costRoad.set(nd.x,nd.y,nd.k)
        //     // visual.text(costRoad.get(nd.x,nd.y),nd.x,nd.y+0.25, {color: "pink",opacity:0.99,font: 7})
        // })

        // // 将dp的位置进行递归回去
        // let border = visited //边界不能放路
        // border.init()
        // visited.forBorder((x,y,val)=>{visited.set(x,y,1)})
        // structMap["container"].forEach(e=>{
        //     let dfsBack = function (x,y){
        //         let minVal =500;
        //         let finalX = 0;
        //         let finalY = 0;
        //         costRoad.forNear((x,y,val)=>{
        //             let struct = roomStructs.get(x,y)
        //             if(minVal>val&&!visited.get(x,y)&&val>=0&&roomWalkable.get(x,y)&&(!struct||struct=='road'||struct=='rampart')) {
        //                 minVal = val
        //                 finalX = x
        //                 finalY = y
        //             }
        //         },x,y)
        //         if(minVal){
        //             if("road"!=roomStructs.exec(finalX,finalY,"road")){
        //                 structMap["road"].push([finalX,finalY]);
        //                 dfsBack(finalX,finalY)
        //             }
        //         }
        //         // visual.text(minVal,finalX,finalY+0.25, {color: "pink",opacity:0.99,font: 7})
        //     }
        //     dfsBack(e[0],e[1])
        //     structMap["road"].forEach(e=>costRoad.set(e[0],e[1],0))
        // })

        //#endregion

        // 可视化部分
        // allCacheMap[finalPos].forEach(t=>{
        //     visual.circle(t.x, t.y, {fill: "#33ff00", radius: 0.5 ,opacity : 0.03})
        // })
        // putAbleList.forEach(t=>{
        //     visual.circle(t.x, t.y, {fill: "#b300ff", radius: 0.5 ,opacity : 0.1})
        // })

        // roomStructs.init()
        // _.keys(CONTROLLER_STRUCTURES).forEach(struct=>structMap[struct].forEach(e=>roomStructs.set(e[0],e[1],struct)))


        // let t = Game.cpu.getUsed()
        // console.log(Game.cpu.getUsed()-t)
        pro.dismiss();

        // HelperVisual.showRoomStructures(roomName,structMap)

        // clog(roomName,structMap["extension"].length,structMap["spawn"].length,wallCnt,innerPutAbleList.length)
        return {
            roomName: roomName,
            // storagePos:{storageX,storageY},
            // labPos:{labX,labY},
            structMap: structMap
        }

    },

};

commonjsGlobal.ManagerPlanner = pro;
let globalT = false;
var _63_good = {
    run() {
        //console.log("run 63 planner")

        let p = Game.flags.Flag1; // 触发器
        let pa = Game.flags.pa;
        let pb = Game.flags.pb;
        let pc = Game.flags.pc;
        let pm = Game.flags.pm;
        if (p && !globalT) {
            ManagerPlanner.computeManor(p.pos.roomName, [pc, pm, pa, pb]);
            //Game.flags.Flag1.remove()
        }
        //RawMemory.set(JSON.stringify(roomStructsData))
        //console.log(JSON.stringify(roomStructsData));
    }
};

// Any modules that you use that modify the game's prototypes should be require'd
function funcCalculateLayout() {
    let center = Game.flags.center; // 房间中心的位置
    let pa = Game.flags.pa;
    let pb = Game.flags.pb;
    let pc = Game.flags.pc;
    let pm = Game.flags.pm;
    if (center) {
        let points = [pc.pos, pm.pos, pa.pos];
        if (pb)
            points.push(pb.pos);
        build_Layout_v1_1.CalculateLayout(center.pos, points);
    }
}
function funcShowInfo() {
}
// This line monkey patches the global prototypes.
screepsProfiler.enable();
module.exports.loop = errorMapper(() => {
    screepsProfiler.wrap(function () {
        const startCpu = Game.cpu.getUsed(); // 记录开始时间
        //console.log(`startCpu : ${startCpu} ms`);
        _63_good.run();
        funcCalculateLayout();
        const endCpu = Game.cpu.getUsed(); // 记录结束时间
        //console.log(`endCpu : ${endCpu} ms`);
        console.log(`CPU 消耗: ${(endCpu - startCpu).toFixed(2)} ms`);
        funcShowInfo();
    });
});
//# sourceMappingURL=main.js.map
