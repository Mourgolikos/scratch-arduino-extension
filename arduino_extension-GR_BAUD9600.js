/*
 *This program is free software: you can redistribute it and/or modify
 *it under the terms of the GNU General Public License as published by
 *the Free Software Foundation, either version 3 of the License, or
 *(at your option) any later version.
 *
 *This program is distributed in the hope that it will be useful,
 *but WITHOUT ANY WARRANTY; without even the implied warranty of
 *MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *GNU General Public License for more details.
 *
 *You should have received a copy of the GNU General Public License
 *along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

(function(ext) {

  var PIN_MODE = 0xF4,
    REPORT_DIGITAL = 0xD0,
    REPORT_ANALOG = 0xC0,
    DIGITAL_MESSAGE = 0x90,
    START_SYSEX = 0xF0,
    END_SYSEX = 0xF7,
    QUERY_FIRMWARE = 0x79,
    REPORT_VERSION = 0xF9,
    ANALOG_MESSAGE = 0xE0,
    ANALOG_MAPPING_QUERY = 0x69,
    ANALOG_MAPPING_RESPONSE = 0x6A,
    CAPABILITY_QUERY = 0x6B,
    CAPABILITY_RESPONSE = 0x6C;

  var INPUT = 0x00,
    OUTPUT = 0x01,
    ANALOG = 0x02,
    PWM = 0x03,
    SERVO = 0x04,
    SHIFT = 0x05,
    I2C = 0x06;

  var LOW = 0,
    HIGH = 1;
  
  var MAX_DATA_BYTES = 4096;
  var MAX_PINS = 128;

  var parsingSysex = false,
    waitForData = 0,
    executeMultiByteCommand = 0,
    multiByteChannel = 0,
    sysexBytesRead = 0,
    storedInputData = new Uint8Array(MAX_DATA_BYTES);

  var digitalOutputData = new Uint8Array(16),
    digitalInputData = new Uint8Array(16),
    analogInputData = new Uint16Array(16);

  var analogChannel = new Uint8Array(MAX_PINS);
  var pinModes = [];
  for (var i = 0; i < 7; i++) pinModes[i] = [];

  var majorVersion = 0,
    minorVersion = 0;
  
  var connected = false;
  var notifyConnection = false;
  var device = null;
  var inputData = null;

  // TEMPORARY WORKAROUND
  // Since _deviceRemoved is not used with Serial devices
  // ping device regularly to check connection
  var pinging = false;
  var pingCount = 0;
  var pinger = null;

  var hwList = new HWList();

  function HWList() {
    this.devices = []

    this.add = function(dev, pin) {
      var device = this.search(dev);
      if (!device) {
        device = {name: dev, pin: pin, val: 0};
        this.devices.push(device);
      } else {
        device.pin = pin;
        device.val = 0;
      }
    };

    this.search = function(dev) {
      for (var i=0; i<this.devices.length; i++) {
        if (this.devices[i].name === dev)
          return this.devices[i];
      }
      return null;
    };
  }

  function init() {

    for (var i = 0; i < 16; i++) {
      var output = new Uint8Array([REPORT_DIGITAL | i, 0x01]);
      device.send(output.buffer);
    }

    queryCapabilities();

    // TEMPORARY WORKAROUND
    // Since _deviceRemoved is not used with Serial devices
    // ping device regularly to check connection
    pinger = setInterval(function() {
      if (pinging) {
        if (++pingCount > 6) {
          clearInterval(pinger);
          pinger = null;
          connected = false;
          if (device) device.close();
          device = null;
          return;
        }
      } else {
        if (!device) {
          clearInterval(pinger);
          pinger = null;
          return;
        }
        queryFirmware();
        pinging = true;
      }
    }, 100);
  }

  function hasCapability(pin, mode) {
    if (pinModes[mode].indexOf(pin) > -1)
      return true;
    else
      return false;
  }

  function queryFirmware() {
    var output = new Uint8Array([START_SYSEX, QUERY_FIRMWARE, END_SYSEX]);
    device.send(output.buffer);
  }
 
  function queryCapabilities() {
    console.log('Έλεγχος ' + device.id + ' ικανότητες');//// TRANSLATED!
    var msg = new Uint8Array([
        START_SYSEX, CAPABILITY_QUERY, END_SYSEX]);
    device.send(msg.buffer);
  }

  function queryAnalogMapping() {
    console.log('Έλεγχος ' + device.id + ' αναλογική χαρτογράφηση');//// TRANSLATED!
    var msg = new Uint8Array([
        START_SYSEX, ANALOG_MAPPING_QUERY, END_SYSEX]);
    device.send(msg.buffer);
  }

  function setDigitalInputs(portNum, portData) {
    digitalInputData[portNum] = portData;
  }

  function setAnalogInput(pin, val) {
    analogInputData[pin] = val;
  }

  function setVersion(major, minor) {
    majorVersion = major;
    minorVersion = minor;
  }

  function processSysexMessage() {
    switch(storedInputData[0]) {
      case CAPABILITY_RESPONSE:
        for (var i = 1, pin = 0; pin < MAX_PINS; pin++) {
          while (storedInputData[i++] != 0x7F) {
            pinModes[storedInputData[i-1]].push(pin);
            i++; //Skip mode resolution
          }
          if (i == sysexBytesRead) break;
        }
        queryAnalogMapping();
        break;
      case ANALOG_MAPPING_RESPONSE:
        for (var pin = 0; pin < analogChannel.length; pin++)
          analogChannel[pin] = 127;
        for (var i = 1; i < sysexBytesRead; i++)
          analogChannel[i-1] = storedInputData[i];
        for (var pin = 0; pin < analogChannel.length; pin++) {
          if (analogChannel[pin] != 127) {
            var out = new Uint8Array([
                REPORT_ANALOG | analogChannel[pin], 0x01]);
            device.send(out.buffer);
          }
        }
        notifyConnection = true;
        setTimeout(function() {
          notifyConnection = false;
        }, 100);
        break;
      case QUERY_FIRMWARE:
        if (!connected) {
          clearInterval(poller);
          poller = null;
          clearTimeout(watchdog);
          watchdog = null;
          connected = true;
          setTimeout(init, 200);
        }
        pinging = false;
        pingCount = 0;
        break;
    }
  }

  function processInput(inputData) { 
    for (var i=0; i < inputData.length; i++) {
      
      if (parsingSysex) {
        if (inputData[i] == END_SYSEX) {
          parsingSysex = false;
          processSysexMessage();
        } else {
          storedInputData[sysexBytesRead++] = inputData[i];
        }
      } else if (waitForData > 0 && inputData[i] < 0x80) {
        storedInputData[--waitForData] = inputData[i];
        if (executeMultiByteCommand != 0 && waitForData == 0) {
          switch(executeMultiByteCommand) {
            case DIGITAL_MESSAGE:
              setDigitalInputs(multiByteChannel, (storedInputData[0] << 7) + storedInputData[1]);
              break;
            case ANALOG_MESSAGE:
              setAnalogInput(multiByteChannel, (storedInputData[0] << 7) + storedInputData[1]);
              break;
            case REPORT_VERSION:
              setVersion(storedInputData[1], storedInputData[0]);
              break;
          }
        }
      } else {
        if (inputData[i] < 0xF0) {
          command = inputData[i] & 0xF0;
          multiByteChannel = inputData[i] & 0x0F;
        } else {
          command = inputData[i];
        }
        switch(command) {
          case DIGITAL_MESSAGE:
          case ANALOG_MESSAGE:
          case REPORT_VERSION:
            waitForData = 2;
            executeMultiByteCommand = command;
            break;
          case START_SYSEX:
            parsingSysex = true;
            sysexBytesRead = 0;
            break;
        }
      }
    }
  }

  function pinMode(pin, mode) {
    var msg = new Uint8Array([PIN_MODE, pin, mode]);
    device.send(msg.buffer);
  }

  function analogRead(pin) {
    if (pin >= 0 && pin < pinModes[ANALOG].length) {
      return Math.round((analogInputData[pin] * 100) / 1023);
    } else {
      var valid = [];
      for (var i = 0; i < pinModes[ANALOG].length; i++)
        valid.push(i);
      console.log('ΣΦΑΛΜΑ: τα έγκυρα αναλογικά pin είναι ' + valid.join(', '));//// TRANSLATED!
      return;
    }
  }

  function digitalRead(pin) {
    if (!hasCapability(pin, INPUT)) {
      console.log('ΣΦΑΛΜΑ: τα έγκυρα pin εισόδου είναι ' + pinModes[INPUT].join(', '));//// TRANSLATED!
      return;
    }
    pinMode(pin, INPUT);
    return (digitalInputData[pin >> 3] >> (pin & 0x07)) & 0x01;
  }

  function analogWrite(pin, val) {
    if (!hasCapability(pin, PWM)) {
      console.log('ΣΦΑΛΜΑ: τα έγκυρα PWN pin είναι ' + pinModes[PWM].join(', '));//// TRANSLATED!
      return;
    }
    if (val < 0) val = 0;
    else if (val > 100) val = 100
    val = Math.round((val / 100) * 255);
    pinMode(pin, PWM);
    var msg = new Uint8Array([
        ANALOG_MESSAGE | (pin & 0x0F),
        val & 0x7F,
        val >> 7]);
    device.send(msg.buffer);
  }

  function digitalWrite(pin, val) {
    if (!hasCapability(pin, OUTPUT)) {
      console.log('ΣΦΑΛΜΑ: τα έγκυρα pin εξόδου είναι ' + pinModes[OUTPUT].join(', '));//// TRANSLATED!
      return;
    }
    var portNum = (pin >> 3) & 0x0F;
    if (val == LOW)
      digitalOutputData[portNum] &= ~(1 << (pin & 0x07));
    else
      digitalOutputData[portNum] |= (1 << (pin & 0x07));
    pinMode(pin, OUTPUT);
    var msg = new Uint8Array([
        DIGITAL_MESSAGE | portNum,
        digitalOutputData[portNum] & 0x7F,
        digitalOutputData[portNum] >> 0x07]);
    device.send(msg.buffer);
  }

  function rotateServo(pin, deg) {
    if (!hasCapability(pin, SERVO)) {
      console.log('ΣΦΑΛΜΑ: τα έγκυρα pin για servo είναι ' + pinModes[SERVO].join(', '));//// TRANSLATED!
      return;
    }
    pinMode(pin, SERVO);
    var msg = new Uint8Array([
        ANALOG_MESSAGE | (pin & 0x0F),
        deg & 0x7F,
        deg >> 0x07]);
    device.send(msg.buffer);
  }

  ext.whenConnected = function() {
    if (notifyConnection) return true;
    return false;
  };

  ext.analogWrite = function(pin, val) {
    analogWrite(pin, val);
  };

  ext.digitalWrite = function(pin, val) {
    if (val == 'ενεργοποιημένο')//// TRANSLATED!
      digitalWrite(pin, HIGH);
    else if (val == 'απενεργοποιημένο')//// TRANSLATED!
      digitalWrite(pin, LOW);
  };

  ext.analogRead = function(pin) {
    return analogRead(pin);
  };

  ext.digitalRead = function(pin) {
    return digitalRead(pin);
  };

  ext.whenAnalogRead = function(pin, op, val) {
    if (pin >= 0 && pin < pinModes[ANALOG].length) {
      if (op == '>')
        return analogRead(pin) > val;
      else if (op == '<')
        return analogRead(pin) < val;
      else if (op == '=')
        return analogRead(pin) == val;
      else
        return false;
    }
  };

  ext.whenDigitalRead = function(pin, val) {
    if (hasCapability(pin, INPUT)) {
      if (val == 'ενεργοποιημένο')//// TRANSLATED!
        return digitalRead(pin);
      else if (val == 'απενεργοποιημένο')//// TRANSLATED!
        return digitalRead(pin) == false;
    }
  };

  ext.connectHW = function(hw, pin) {
    hwList.add(hw, pin);
  };

  ext.rotateServo = function(servo, deg) {
    var hw = hwList.search(servo);
    if (!hw) return;
    if (deg < 0) deg = 0;
    else if (deg > 180) deg = 180;
    rotateServo(hw.pin, deg);
    hw.val = deg;
  };

  ext.changeServo = function(servo, change) {
    var hw = hwList.search(servo);
    if (!hw) return;
    var deg = hw.val + change;
    if (deg < 0) deg = 0;
    else if (deg > 180) deg = 180;
    rotateServo(hw.pin, deg);
    hw.val = deg;
  };

  ext.setLED = function(led, val) {
    var hw = hwList.search(led);
    if (!hw) return;
    analogWrite(hw.pin, val);
    hw.val = val;
  };

  ext.changeLED = function(led, val) {
    var hw = hwList.search(led);
    if (!hw) return;
    var b = hw.val + val;
    if (b < 0) b = 0;
    else if (b > 100) b = 100;
    analogWrite(hw.pin, b);
    hw.val = b;
  };

  ext.digitalLED = function(led, val) {
    var hw = hwList.search(led);
    if (!hw) return;
    if (val == 'ενεργοποιημένο') {//// TRANSLATED!
      digitalWrite(hw.pin, HIGH);
      hw.val = 255;
    } else if (val == 'απενεργοποιημένο') {//// TRANSLATED!
      digitalWrite(hw.pin, LOW);
      hw.val = 0;
    }
  };
  
  ext.readInput = function(name) {
    var hw = hwList.search(name);
    if (!hw) return;
    return analogRead(hw.pin);
  };

  ext.whenButton = function(btn, state) {
    var hw = hwList.search(btn);
    if (!hw) return;
    if (state === 'πατημένο')//// TRANSLATED!
      return digitalRead(hw.pin);
    else if (state === 'ελεύθερο')//// TRANSLATED!
      return !digitalRead(hw.pin);
  };

  ext.isButtonPressed = function(btn) {
    var hw = hwList.search(btn);
    if (!hw) return;
    return digitalRead(hw.pin);
  };

  ext.whenInput = function(name, op, val) {
    var hw = hwList.search(name);
    if (!hw) return;
    if (op == '>')
      return analogRead(hw.pin) > val;
    else if (op == '<')
      return analogRead(hw.pin) < val;
    else if (op == '=')
      return analogRead(hw.pin) == val;
    else
      return false;
  };

  ext.mapValues = function(val, aMin, aMax, bMin, bMax) {
    var output = (((bMax - bMin) * (val - aMin)) / (aMax - aMin)) + bMin;
    return Math.round(output);
  };
 
  ext._getStatus = function() {
    if (!connected)
      return { status:1, msg:'Αποσυνδέθηκε' };//// TRANSLATED!
    else
      return { status:2, msg:'Συνδέθηκε' };//// TRANSLATED!
  };

  ext._deviceRemoved = function(dev) {
    console.log('Η συσκευή αφαιρέθηκε');//// TRANSLATED!
    // Not currently implemented with serial devices
  };

  var potentialDevices = [];
  ext._deviceConnected = function(dev) {
    potentialDevices.push(dev);
    if (!device)
      tryNextDevice();
  };

  var poller = null;
  var watchdog = null;
  function tryNextDevice() {
    device = potentialDevices.shift();
    if (!device) return;

    device.open({ stopBits: 0, bitRate: 9600, ctsFlowControl: 0 });
    console.log('Προσπάθεια σύνδεσης με ' + device.id);//// TRANSLATED!
    device.set_receive_handler(function(data) {
      var inputData = new Uint8Array(data);
      processInput(inputData);
    });

    poller = setInterval(function() {
      queryFirmware();
    }, 1000);

    watchdog = setTimeout(function() {
      clearInterval(poller);
      poller = null;
      device.set_receive_handler(null);
      device.close();
      device = null;
      tryNextDevice();
    }, 5000);
  };

  ext._shutdown = function() {
    // TODO: Bring all pins down 
    if (device) device.close();
    if (poller) clearInterval(poller);
    device = null;
  };

  var descriptor = {//// TRANSLATED!
    blocks: [
      ['h', 'Όταν η συσκευή είναι συνδεδεμένη', 'whenConnected'],
      [' ', 'σύνδεσε το %m.hwOut στο pin %n', 'connectHW', 'led A', 3],
      [' ', 'σύνδεσε το %m.hwIn στο αναλογικό %n', 'connectHW', 'ποντεσιόμετρο', 0],
      ['-'],
      [' ', 'άλλαξε το %m.leds σε %m.outputs', 'digitalLED', 'led A', 'ενεργοποιημένο'],
      [' ', 'όρισε στο %m.leds τη φωτεινότητα ίση με %n%', 'setLED', 'led A', 100],
      [' ', 'άλλαξε στο %m.leds τη φωτεινότητα κατά %n%', 'changeLED', 'led A', 20],
      ['-'],
      [' ', 'στρίψε το %m.servos στις %n μοίρες', 'rotateServo', 'servo A', 180],
      [' ', 'στρίψε το %m.servos κατά %n μοίρες', 'changeServo', 'servo A', 20],
      ['-'],
      ['h', 'Όταν το %m.buttons είναι %m.btnStates', 'whenButton', 'κουμπί A', 'πατημένο'],
      ['b', 'το %m.buttons πατήθηκε', 'isButtonPressed', 'κουμπί A'],
      ['-'],
      ['h', 'Όταν το %m.hwIn %m.ops %n%', 'whenInput', 'ποντεσιόμετρο', '>', 50],
      ['r', 'διάβασε %m.hwIn', 'readInput', 'ποντεσιόμετρο'],
      ['-'],
      [' ', 'άλλαξε το pin %n σε %m.outputs', 'digitalWrite', 1, 'ενεργοποιημένο'],
      [' ', 'όρισε το pin %n σε %n%', 'analogWrite', 3, 100],
      ['-'],
      ['h', 'Όταν το pin %n είναι %m.outputs', 'whenDigitalRead', 1, 'ενεργοποιημένο'],
      ['b', 'το pin %n είναι ενεργοποιημένο', 'digitalRead', 1],
      ['-'],
      ['h', 'Όταν το αναλογικό %n %m.ops %n%', 'whenAnalogRead', 1, '>', 50],
      ['r', 'διάβασε το αναλογικό %n', 'analogRead', 0],
      ['-'],
      ['r', 'χαρτογράφισε %n από %n %n έως %n %n', 'mapValues', 50, 0, 100, -240, 240]
    ],  
    menus: {
      buttons: ['κουμπί A', 'κουμπί B', 'κουμπί C', 'κουμπί D'],
      btnStates: ['πατημένο', 'ελεύθερο'],
      hwIn: ['ποντεσιόμετρο', 'φωτοαισθητήρα A', 'φωτοαισθητήρα B', 'θερμοαισθητήρα'],
      hwOut: ['led A', 'led B', 'led C', 'led D', 'led E', 'led F', 'led G', 'κουμπί A', 'κουμπί B', 'κουμπί C', 'κουμπί D', 'servo A', 'servo B', 'servo C', 'servo D'],//added "led E", "led F", "led G"
      leds: ['led A', 'led B', 'led C', 'led D', 'led E', 'led F', 'led G'],//added "led E", "led F", "led G"
      outputs: ['ενεργοποιημένο', 'απενεργοποιημένο'],
      ops: ['>', '=', '<'],
      servos: ['servo A', 'servo B', 'servo C', 'servo D']
    },  
    url: 'https://github.com/Mourgolikos/scratch-arduino-extension'
  };

  ScratchExtensions.register('Arduino', descriptor, ext, {type:'serial'});

})({});
