/**
 * Web Serial + Web Bluetooth 双模适配器
 * PC端浏览器版本 - 同时支持串口和BLE蓝牙
 * 
 * 功能：
 * 1. Web Serial API - 连接串口/COM口（包括蓝牙SPP转COM）
 * 2. Web Bluetooth API - 直接连接BLE低功耗蓝牙设备
 */

(function() {
    'use strict';

    // ========================================
    // 全局状态
    // ========================================
    let currentMode = null; // 'serial' 或 'ble'
    let isConnected = false;
    let subscribeCallback = null;
    let rawSubscribeCallback = null;
    let delimiter = '\n';
    
    // Serial 相关
    let serialPort = null;
    let serialReader = null;
    let serialWriter = null;
    
    // BLE 相关
    let bleDevice = null;
    let bleServer = null;
    let bleService = null;
    let bleTxCharacteristic = null;
    let bleRxCharacteristic = null;
    let bleKeepaliveTimer = null;
    
    // 常见的 BLE UART Service UUIDs
    const BLE_UART_SERVICES = [
        // Nordic UART Service
        '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
        // HM-10/CC2541
        '0000ffe0-0000-1000-8000-00805f9b34fb',
        // 通用串口服务
        '00001101-0000-1000-8000-00805f9b34fb'
    ];
    
    const BLE_TX_CHARACTERISTICS = [
        '6e400002-b5a3-f393-e0a9-e50e24dcca9e', // Nordic TX
        '0000ffe1-0000-1000-8000-00805f9b34fb'  // HM-10
    ];
    
    const BLE_RX_CHARACTERISTICS = [
        '6e400003-b5a3-f393-e0a9-e50e24dcca9e', // Nordic RX
        '0000ffe1-0000-1000-8000-00805f9b34fb'  // HM-10 (same as TX)
    ];

    // 获取配置的波特率
    function getBaudRate() {
        try {
            const cfg = JSON.parse(localStorage.getItem('bt_settings') || '{}');
            return parseInt(cfg.baudRate) || 115200;
        } catch(e) {
            return 115200;
        }
    }

    // ========================================
    // 检测浏览器支持
    // ========================================
    const hasSerial = !!navigator.serial;
    const hasBluetooth = !!navigator.bluetooth;
    
    // WebSocket 桥接支持 (Python Bridge)
    let wsBridge = null;
    let hasBridge = false;
    let isConnecting = false; // 防止重复连接
    
    // ESP32 WiFi 桥接支持
    let esp32Bridge = null;
    let hasESP32Bridge = false;
    let esp32Connecting = false;
    
    // 尝试连接 WebSocket 桥接
    function initBridge() {
        try {
            // 防止重复连接
            if (isConnecting || (wsBridge && (wsBridge.readyState === WebSocket.CONNECTING || wsBridge.readyState === WebSocket.OPEN))) {
                return;
            }
            
            isConnecting = true;
            wsBridge = new WebSocket('ws://localhost:8766');
            
            wsBridge.onopen = () => {
                console.log('🔌 桥接已连接');
                hasBridge = true;
                isConnecting = false;
            };
            
            wsBridge.onclose = () => {
                console.log('🔌 桥接断开');
                hasBridge = false;
                wsBridge = null;
                isConnecting = false;
            };
            
            wsBridge.onerror = (e) => {
                console.log('🔌 桥接错误');
                hasBridge = false;
                isConnecting = false;
            };
            wsBridge.onmessage = (event) => {
                // 处理二进制数据（来自WiFi桥接器）
                if (event.data instanceof ArrayBuffer || event.data instanceof Blob) {
                    const data = new Uint8Array(event.data);
                    if (rawSubscribeCallback) rawSubscribeCallback(data.buffer);
                    if (subscribeCallback) {
                        const text = new TextDecoder().decode(data);
                        // 简单处理 buffer
                        bleBuffer += text;
                        if (delimiter && bleBuffer.includes(delimiter)) {
                             const parts = bleBuffer.split(delimiter);
                             for (let i=0; i<parts.length-1; i++) subscribeCallback(parts[i]);
                             bleBuffer = parts[parts.length-1];
                        }
                    }
                    return;
                }
                
                // 处理JSON数据（来自BLE桥接器）
                try {
                    const msg = JSON.parse(event.data);
                    if (msg.type === 'data') {
                        // 收到数据
                        const data = new Uint8Array(msg.data);
                        if (rawSubscribeCallback) rawSubscribeCallback(data.buffer);
                        if (subscribeCallback) {
                            const text = new TextDecoder().decode(data);
                            // 简单处理 buffer
                            bleBuffer += text;
                            if (delimiter && bleBuffer.includes(delimiter)) {
                                 const parts = bleBuffer.split(delimiter);
                                 for (let i=0; i<parts.length-1; i++) subscribeCallback(parts[i]);
                                 bleBuffer = parts[parts.length-1];
                            } else {
                                 subscribeCallback(text);
                                 bleBuffer = '';
                            }
                        }
                    } else if (msg.type === 'scan_result') {
                    // 扫描结果
                    if (onBridgeScanResult) onBridgeScanResult(msg.devices);
                } else if (msg.type === 'auto_connected') {
                    // HC-06 自动连接成功
                    console.log('🎉 HC-06 Auto-Connected:', msg.address);
                    isConnected = true;
                    currentMode = 'ble-bridge';
                    alert('✅ 已自动连接到 HC-06!\n地址: ' + msg.address);
                    // 通知等待中的 Promise
                    if (onBridgeScanResult) onBridgeScanResult(null); // null 表示已自动连接
                } else if (msg.type === 'connected') {
                    console.log('Bridge Connected:', msg.address);
                    isConnected = true;
                    currentMode = 'ble-bridge';
                } else if (msg.type === 'disconnected') {
                    console.log('Bridge Disconnected');
                    isConnected = false;
                    currentMode = null;
                }
                } catch (jsonError) {
                    console.log('WebSocket 收到非JSON数据，已作为二进制处理');
                }
            };
        } catch (e) {
            console.log('WebSocket bridge init failed', e);
        }
    }
    
    async function ensureBridgeReady(timeout = 4000) {
        if(hasBridge)
            return true;
        
        // 只调用一次 initBridge，然后等待
        if (!isConnecting && (!wsBridge || wsBridge.readyState === WebSocket.CLOSED)) {
            initBridge();
        }
        
        const start = Date.now();
        while(Date.now() - start < timeout) {
            if(hasBridge)
                return true;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return hasBridge;
    }

    // 直接地址连接
    async function bleConnectDirect(address) {
        if (!address) {
            // 弹出输入框让用户输入地址
            address = prompt('请输入蓝牙设备地址 (如: A4:40:5B:E7:7E:DC):', 'A4:40:5B:E7:7E:DC');
            if (!address) return null;
        }
        
        // 确保桥接就绪
        const ready = await ensureBridgeReady();
        if (!ready) {
            alert('❌ 桥接未就绪，请确保 NativeBLEBridge.exe 正在运行');
            return null;
        }
        
        // 设置连接状态
        setStatus('connecting');
        
        // 发送直接连接命令
        wsBridge.send(JSON.stringify({
            cmd: 'connect_direct',
            address: address
        }));
        
        // 等待连接结果
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                setStatus('disconnected');
                reject(new Error('连接超时'));
            }, 15000);
            
            const handleMessage = (event) => {
                const msg = JSON.parse(event.data);
                if (msg.type === 'connected') {
                    clearTimeout(timeout);
                    wsBridge.removeEventListener('message', handleMessage);
                    
                    // 更新连接状态 - 调用与正常连接相同的成功处理
                    isConnected = true;
                    currentMode = 'ble-bridge';
                    setStatus('connected');
                    
                    // 调用成功回调（如果存在）
                    if (window.onConn) {
                        window.onConn('ble');
                    }
                    
                    log('SYS', `✅ 已直接连接到 ${msg.address}`);
                    resolve(msg.address);
                } else if (msg.type === 'error') {
                    clearTimeout(timeout);
                    wsBridge.removeEventListener('message', handleMessage);
                    setStatus('disconnected');
                    reject(new Error(msg.message));
                }
            };
            
            wsBridge.addEventListener('message', handleMessage);
        });
    }

    // 启动连接
    initBridge();
    
    // 暴露直接连接函数到全局
    window.bleConnectDirect = bleConnectDirect;
    
    // ========================================
    // Python BLE 桥接器 (高速)
    // ========================================
    let pythonBridge = null;
    let pythonConnecting = false;
    
    async function connectPythonBLE() {
        if (pythonConnecting) return false;
        
        try {
            pythonConnecting = true;
            console.log('[Python BLE] 连接桥接器...');
            
            pythonBridge = new WebSocket('ws://localhost:8766');
            
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    pythonConnecting = false;
                    reject(new Error('连接超时'));
                }, 5000);
                
                pythonBridge.onopen = () => {
                    clearTimeout(timeout);
                    console.log('[Python BLE] 桥接器连接成功');
                    
                    // 请求连接 ESP32
                    pythonBridge.send(JSON.stringify({
                        type: 'connect'
                    }));
                };
                
                pythonBridge.onmessage = (event) => {
                    const data = JSON.parse(event.data);
                    
                    if (data.type === 'connect_response') {
                        pythonConnecting = false;
                        if (data.success) {
                            currentMode = 'python_ble';
                            isConnected = true;
                            console.log('[Python BLE] ESP32 连接成功');
                            resolve(true);
                        } else {
                            reject(new Error('ESP32 连接失败'));
                        }
                    } else if (data.type === 'data') {
                        // 收到数据
                        const hexData = data.data;
                        const bytes = new Uint8Array(hexData.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
                        
                        if (rawSubscribeCallback) {
                            rawSubscribeCallback(bytes.buffer);
                        }
                        if (subscribeCallback) {
                            const text = new TextDecoder().decode(bytes);
                            subscribeCallback(text);
                        }
                    }
                };
                
                pythonBridge.onclose = () => {
                    console.log('[Python BLE] 连接断开');
                    pythonConnecting = false;
                    if (currentMode === 'python_ble') {
                        isConnected = false;
                        currentMode = null;
                    }
                };
                
                pythonBridge.onerror = () => {
                    clearTimeout(timeout);
                    pythonConnecting = false;
                    reject(new Error('桥接器连接失败'));
                };
            });
            
        } catch (e) {
            pythonConnecting = false;
            throw e;
        }
    }
    
    async function pythonBLEWrite(data) {
        if (!pythonBridge || pythonBridge.readyState !== WebSocket.OPEN) {
            throw new Error('Python BLE 桥接器未连接');
        }
        
        let bytes;
        if (typeof data === 'string') {
            bytes = new TextEncoder().encode(data);
        } else if (data instanceof ArrayBuffer) {
            bytes = new Uint8Array(data);
        } else {
            bytes = new Uint8Array(data);
        }
        
        // 转换为十六进制
        const hexData = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
        
        pythonBridge.send(JSON.stringify({
            type: 'data',
            data: hexData
        }));
        
        console.log('[Python BLE] 发送:', bytes.length, '字节');
    }
    
    // ========================================
    // ESP32 WiFi 桥接
    // ========================================
    async function esp32Connect(url) {
        // 默认地址 - 直接使用端口 81
        if (!url) {
            url = prompt('请输入 ESP32 WebSocket 地址:', 'ws://192.168.4.1:81');
            if (!url) return false;
        }
        
        // 确保 URL 格式正确
        if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
            url = 'ws://' + url;
        }
        // 如果没有指定端口，添加端口 81
        if (url === 'ws://192.168.4.1' || url === 'ws://192.168.4.1/') {
            url = 'ws://192.168.4.1:81';
        }
        
        return new Promise((resolve, reject) => {
            try {
                esp32Connecting = true;
                console.log('[ESP32] 正在连接:', url);
                
                // 复用 wsBridge，不创建新连接
                if (wsBridge && wsBridge.readyState === WebSocket.OPEN) {
                    console.log('[ESP32] ✓ 复用已有连接');
                    esp32Bridge = wsBridge;
                    esp32Bridge.binaryType = 'arraybuffer';
                    hasESP32Bridge = true;
                    esp32Connecting = false;
                    isConnected = true;
                    currentMode = 'esp32';
                    resolve(true);
                    return;
                }
                
                esp32Bridge = new WebSocket(url);
                esp32Bridge.binaryType = 'arraybuffer';
                
                const timeout = setTimeout(() => {
                    esp32Connecting = false;
                    esp32Bridge.close();
                    reject(new Error('连接超时'));
                }, 10000);
                
                esp32Bridge.onopen = () => {
                    clearTimeout(timeout);
                    console.log('[ESP32] ✓ 已连接');
                    hasESP32Bridge = true;
                    esp32Connecting = false;
                    isConnected = true;
                    currentMode = 'esp32';
                    // 同步到 wsBridge
                    wsBridge = esp32Bridge;
                    hasBridge = true;
                    resolve(true);
                };
                
                esp32Bridge.onclose = () => {
                    console.log('[ESP32] 连接断开');
                    hasESP32Bridge = false;
                    esp32Connecting = false;
                    if (currentMode === 'esp32') {
                        isConnected = false;
                        currentMode = null;
                    }
                };
                
                esp32Bridge.onerror = (e) => {
                    clearTimeout(timeout);
                    console.log('[ESP32] 连接错误');
                    hasESP32Bridge = false;
                    esp32Connecting = false;
                    reject(new Error('连接失败'));
                };
                
                esp32Bridge.onmessage = (event) => {
                    // 检查是否是 JSON 消息（桥接器命令响应）
                    if (typeof event.data === 'string') {
                        try {
                            const json = JSON.parse(event.data);
                            console.log('[Bridge] JSON:', json.type || json);
                            // 触发自定义事件，让 UI 处理
                            window.dispatchEvent(new CustomEvent('bridge-message', { detail: json }));
                            return;
                        } catch(e) {
                            // 不是 JSON，继续当作文本处理
                        }
                    }
                    
                    // 收到来自 ESP32 的数据 (GD32 透传)
                    const data = new Uint8Array(event.data);
                    console.log('[ESP32<-GD32]', data.length, 'bytes');
                    
                    if (rawSubscribeCallback) {
                        rawSubscribeCallback(data.buffer);
                    }
                    if (subscribeCallback) {
                        const text = new TextDecoder().decode(data);
                        subscribeCallback(text);
                    }
                };
                
            } catch (e) {
                esp32Connecting = false;
                reject(e);
            }
        });
    }
    
    async function esp32Disconnect() {
        if (esp32Bridge) {
            esp32Bridge.close();
            esp32Bridge = null;
        }
        hasESP32Bridge = false;
        if (currentMode === 'esp32') {
            isConnected = false;
            currentMode = null;
        }
    }
    
    async function esp32Write(data) {
        if (!esp32Bridge || esp32Bridge.readyState !== WebSocket.OPEN) {
            throw new Error('ESP32 未连接');
        }
        
        let buffer;
        if (typeof data === 'string') {
            buffer = new TextEncoder().encode(data);
        } else if (data instanceof ArrayBuffer) {
            buffer = new Uint8Array(data);
        } else if (data instanceof Uint8Array) {
            buffer = data;
        } else if (Array.isArray(data)) {
            buffer = new Uint8Array(data);
        } else {
            throw new Error('不支持的数据类型');
        }
        
        esp32Bridge.send(buffer);
        console.log('[ESP32->GD32]', buffer.length, 'bytes');
    }
    
    // 暴露 ESP32 连接函数
    window.esp32Connect = esp32Connect;
    window.connectESP32 = esp32Connect;

    console.log('浏览器支持检测:');
    console.log('  - Web Serial API:', hasSerial ? '✓ 支持' : '✗ 不支持');
    console.log('  - Web Bluetooth API:', hasBluetooth ? '✓ 支持' : '✗ 不支持');

    if (!hasSerial && !hasBluetooth) {
        console.error('此浏览器不支持 Web Serial 和 Web Bluetooth API');
        alert('您的浏览器不支持串口和蓝牙功能，请使用 Chrome 或 Edge 浏览器！');
        return;
    }
    
    let onBridgeScanResult = null;

    // ========================================
    // Serial 串口功能
    // ========================================
    
    // 保存最近使用的串口信息
    function saveLastSerialPort(port) {
        try {
            const info = port.getInfo();
            localStorage.setItem('last_serial_port', JSON.stringify({
                usbVendorId: info.usbVendorId,
                usbProductId: info.usbProductId,
                time: Date.now()
            }));
        } catch(e) {}
    }
    
    // 获取已授权的串口（优先最近使用的）
    async function getAuthorizedPorts() {
        if (!hasSerial) return [];
        try {
            const ports = await navigator.serial.getPorts();
            const lastInfo = JSON.parse(localStorage.getItem('last_serial_port') || 'null');
            
            if (lastInfo && ports.length > 1) {
                // 把最近使用的排到前面
                ports.sort((a, b) => {
                    const aInfo = a.getInfo();
                    const bInfo = b.getInfo();
                    const aMatch = aInfo.usbVendorId === lastInfo.usbVendorId && aInfo.usbProductId === lastInfo.usbProductId;
                    const bMatch = bInfo.usbVendorId === lastInfo.usbVendorId && bInfo.usbProductId === lastInfo.usbProductId;
                    return bMatch - aMatch;
                });
            }
            return ports;
        } catch(e) {
            return [];
        }
    }
    
    async function serialConnect() {
        try {
            // 总是弹出选择器让用户选择串口
            serialPort = await navigator.serial.requestPort();
            
            const baudRate = getBaudRate();
            
            await serialPort.open({ 
                baudRate: baudRate,
                dataBits: 8,
                stopBits: 1,
                parity: 'none'
            });
            
            // 保存这个串口为最近使用
            saveLastSerialPort(serialPort);
            
            currentMode = 'serial';
            isConnected = true;
            
            console.log(`串口已连接，波特率: ${baudRate}`);
            
            // 启动读取
            startSerialReading();
            
            return true;
        } catch(err) {
            console.error('串口连接失败:', err);
            throw err;
        }
    }
    
    async function startSerialReading() {
        if (!serialPort || !serialPort.readable) return;
        
        serialReader = serialPort.readable.getReader();
        let buffer = '';
        
        try {
            while (true) {
                const { value, done } = await serialReader.read();
                if (done) break;
                
                // 原始数据回调
                if (rawSubscribeCallback) {
                    rawSubscribeCallback(value.buffer);
                }
                
                // 基于分隔符的回调
                if (subscribeCallback) {
                    const text = new TextDecoder().decode(value);
                    buffer += text;
                    
                    if (delimiter && buffer.includes(delimiter)) {
                        const parts = buffer.split(delimiter);
                        for (let i = 0; i < parts.length - 1; i++) {
                            subscribeCallback(parts[i]);
                        }
                        buffer = parts[parts.length - 1];
                    } else if (!delimiter) {
                        subscribeCallback(text);
                        buffer = '';
                    }
                }
            }
        } catch(err) {
            if (err.name !== 'NetworkError') {
                console.error('串口读取错误:', err);
            }
        } finally {
            if (serialReader) {
                serialReader.releaseLock();
                serialReader = null;
            }
        }
    }
    
    async function serialWrite(data) {
        if (!serialPort || !serialPort.writable) {
            throw new Error('串口未连接');
        }
        
        const writer = serialPort.writable.getWriter();
        try {
            let bytes;
            if (typeof data === 'string') {
                bytes = new TextEncoder().encode(data);
            } else if (data instanceof ArrayBuffer) {
                bytes = new Uint8Array(data);
            } else {
                bytes = new Uint8Array(data);
            }
            await writer.write(bytes);
        } finally {
            writer.releaseLock();
        }
    }
    
    async function serialDisconnect() {
        if (serialReader) {
            try { await serialReader.cancel(); } catch(e) {}
            serialReader = null;
        }
        if (serialPort) {
            try { await serialPort.close(); } catch(e) {}
            serialPort = null;
        }
        currentMode = null;
        isConnected = false;
    }

    // ========================================
    // BLE 蓝牙功能
    // ========================================
    async function bleConnect(deviceId) {
        const bridgeReady = await ensureBridgeReady();

        // 优先使用 WebSocket 桥接
        if (bridgeReady) {
            if (deviceId) {
                console.log('Connecting via Python Bridge to', deviceId);
                
                // 等待连接结果
                return new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        reject(new Error('连接超时'));
                    }, 15000);
                    
                    const handleMessage = (event) => {
                        const msg = JSON.parse(event.data);
                        if (msg.type === 'connected') {
                            clearTimeout(timeout);
                            wsBridge.removeEventListener('message', handleMessage);
                            
                            // 设置连接状态
                            isConnected = true;
                            currentMode = 'ble-bridge';
                            hasBridge = true;
                            
                            console.log('✓ BLE Bridge connected:', deviceId);
                            resolve();
                        } else if (msg.type === 'error') {
                            clearTimeout(timeout);
                            wsBridge.removeEventListener('message', handleMessage);
                            reject(new Error(msg.message));
                        }
                    };
                    
                    wsBridge.addEventListener('message', handleMessage);
                    
                    // 发送连接命令
                    wsBridge.send(JSON.stringify({
                        cmd: 'connect',
                        address: deviceId
                    }));
                });
            } else {
                // 如果没有 ID，先通过 Python 扫描
                console.log('Scanning via Python Bridge (20s)...');
                wsBridge.send(JSON.stringify({ cmd: 'scan' }));
                
                // 等待扫描结果并让用户选择
                return new Promise((resolve, reject) => {
                    onBridgeScanResult = (devices) => {
                        // 如果是 null，表示已自动连接到 HC-06
                        if (devices === null) {
                            console.log('Already auto-connected to HC-06');
                            resolve();
                            return;
                        }
                        
                        if (!devices || devices.length === 0) {
                            alert('未扫描到 BLE 设备');
                            reject(new Error('No devices found'));
                            return;
                        }
                        
                        // 简单构建选择列表
                        let msg = '请选择要连接的设备 (输入序号):\n';
                        devices.forEach((d, index) => {
                            msg += `${index + 1}. ${d.name} (${d.address}, RSSI: ${d.rssi})\n`;
                        });
                        
                        const input = prompt(msg, '1');
                        if (input) {
                            const index = parseInt(input) - 1;
                            if (index >= 0 && index < devices.length) {
                                const selected = devices[index];
                                bleConnect(selected.address); // 递归调用，带 ID
                                resolve();
                            } else {
                                alert('输入无效');
                                reject(new Error('Invalid selection'));
                            }
                        } else {
                            reject(new Error('User cancelled'));
                        }
                    };
                });
            }
        }
    
        try {
            // 请求蓝牙设备（不筛选服务，尝试获取所有可选服务）
            // 注意：Web Bluetooth 需要指定 optionalServices 才能访问它们
            // 这里我们列出所有常见的串口服务 UUID
            const ALL_SERVICES = [
                ...BLE_UART_SERVICES,
                '00001800-0000-1000-8000-00805f9b34fb', // Generic Access
                '00001801-0000-1000-8000-00805f9b34fb', // Generic Attribute
                '0000180a-0000-1000-8000-00805f9b34fb', // Device Information
                '0000fff0-0000-1000-8000-00805f9b34fb'  // Common Custom Service
            ];

            bleDevice = await navigator.bluetooth.requestDevice({
                // 优先过滤 HC-06/HC-05 等经典蓝牙模块
                // 注意：许多 HC-06 模块可能不广播标准服务，所以 acceptAllDevices 仍是必须的
                // 但我们可以通过 filters 尝试优先展示
                acceptAllDevices: true,
                optionalServices: ALL_SERVICES
            });
            
            console.log('已选择设备:', bleDevice.name, bleDevice.id);
            
            // 连接 GATT 服务器
            bleServer = await bleDevice.gatt.connect();
            console.log('GATT 服务器已连接');
            
            // 获取所有服务
            const services = await bleServer.getPrimaryServices();
            console.log('发现服务数量:', services.length);
            
            let foundUart = false;

            // 遍历所有服务寻找可用的特征值
            for (const service of services) {
                console.log('检查服务:', service.uuid);
                try {
                    const characteristics = await service.getCharacteristics();
                    for (const char of characteristics) {
                        const props = char.properties;
                        console.log(`  - 特征值 ${char.uuid}: Write=${props.write}, Notify=${props.notify}`);
                        
                        // 寻找写入特征值
                        if ((props.write || props.writeWithoutResponse) && !bleTxCharacteristic) {
                            bleTxCharacteristic = char;
                            console.log('    > 选为写入特征值 (TX)');
                        }
                        
                        // 寻找通知特征值
                        if ((props.notify || props.indicate) && !bleRxCharacteristic) {
                            bleRxCharacteristic = char;
                            console.log('    > 选为接收特征值 (RX)');
                        }
                    }
                } catch(e) {
                    console.warn('  无法获取特征值:', e);
                }
            }
            
            if (!bleTxCharacteristic && !bleRxCharacteristic) {
                throw new Error('未找到可用的读写特征值，该设备可能不是串口透传模块');
            }
            
            // 订阅通知
            if (bleRxCharacteristic) {
                try {
                    await bleRxCharacteristic.startNotifications();
                    bleRxCharacteristic.addEventListener('characteristicvaluechanged', handleBleData);
                    console.log('已订阅数据通知');
                } catch(e) {
                    console.error('订阅通知失败:', e);
                }
            }
            
            // 监听断开事件 - 自动重连
            bleDevice.addEventListener('gattserverdisconnected', onBleDisconnected);

            currentMode = 'ble';
            isConnected = true;
            bleAutoReconnect = true;  // 启用自动重连
            bleReconnectAttempts = 0;
            startBleKeepalive();
            
            // 保存最近使用的蓝牙设备
            localStorage.setItem('last_ble_device', JSON.stringify({
                name: bleDevice.name || '未知设备',
                id: bleDevice.id,
                time: Date.now()
            }));
            
            console.log('BLE 连接成功');
            return true;
            
        } catch(err) {
            console.error('BLE 连接失败:', err);
            throw err;
        }
    }
    
    let bleBuffer = '';
    
    function handleBleData(event) {
        const value = event.target.value;
        const data = new Uint8Array(value.buffer);
        
        // 原始数据回调
        if (rawSubscribeCallback) {
            rawSubscribeCallback(value.buffer);
        }
        
        // 基于分隔符的回调
        if (subscribeCallback) {
            const text = new TextDecoder().decode(data);
            bleBuffer += text;
            
            if (delimiter && bleBuffer.includes(delimiter)) {
                const parts = bleBuffer.split(delimiter);
                for (let i = 0; i < parts.length - 1; i++) {
                    subscribeCallback(parts[i]);
                }
                bleBuffer = parts[parts.length - 1];
            } else if (!delimiter) {
                subscribeCallback(text);
                bleBuffer = '';
            }
        }
    }
    
    // BLE MTU 大小 - HM-10/JDY等透传模块通常只支持20字节
    let bleMTU = 20;  // 保守默认值，兼容所有BLE透传模块
    
    async function bleWrite(data) {
        if (hasBridge && currentMode === 'ble-bridge') {
            let bytesArray;
            if (typeof data === 'string') {
                bytesArray = Array.from(new TextEncoder().encode(data));
            } else if (data instanceof ArrayBuffer) {
                bytesArray = Array.from(new Uint8Array(data));
            } else {
                bytesArray = Array.from(data);
            }
            
            console.log(`📤 BLE Bridge Write: ${bytesArray.length} bytes`, bytesArray);
            
            wsBridge.send(JSON.stringify({
                cmd: 'write',
                data: bytesArray
            }));
            
            // 等待一下确保数据发送
            await new Promise(r => setTimeout(r, 10));
            return;
        }

        if (!bleTxCharacteristic || !bleDevice?.gatt?.connected) {
            console.error('BLE 连接已断开');
            isConnected = false;
            currentMode = null;
            throw new Error('BLE 连接已断开，请重新连接');
        }
        
        let bytes;
        if (typeof data === 'string') {
            bytes = new TextEncoder().encode(data);
        } else if (data instanceof ArrayBuffer) {
            bytes = new Uint8Array(data);
        } else {
            bytes = new Uint8Array(data);
        }
        
        // 使用 200 字节 MTU（与 Python Bridge 一致）
        let MTU = 200;
        
        // 如果是 Windows Web Bluetooth，回退到 20 字节（已知限制）
        if (navigator.platform.includes('Win')) {
            MTU = 20;
        }
        
        console.log('[BLE] 平台:', navigator.platform, '尝试 MTU:', MTU);
        
        for (let i = 0; i < bytes.length; i += MTU) {
            const chunk = bytes.slice(i, i + MTU);
            let retries = 3;
            
            while (retries > 0) {
                try {
                    await bleTxCharacteristic.writeValue(chunk);
                    break;  // 成功，跳出重试循环
                } catch(e) {
                    retries--;
                    console.warn(`BLE 写入失败 (剩余重试: ${retries}):`, e.message);
                    
                    if (retries === 0) {
                        console.error('BLE 写入失败，已重试3次');
                        throw e;
                    }
                    
                    // 等待后重试
                    await new Promise(r => setTimeout(r, 50));
                }
            }
            
            // 包间延迟，给 BLE 模块处理时间
            if (i + MTU < bytes.length) {
                await new Promise(r => setTimeout(r, 15));
            }
        }
    }
    
    // BLE 自动重连相关
    let bleAutoReconnect = true;
    let bleReconnectAttempts = 0;
    const BLE_MAX_RECONNECT_ATTEMPTS = 3;
    
    async function onBleDisconnected() {
        console.log('BLE 设备已断开');
        stopBleKeepalive();
        isConnected = false;
        currentMode = null;
        
        // 清理旧的特征值引用
        bleTxCharacteristic = null;
        bleRxCharacteristic = null;
        
        // 尝试自动重连
        if (bleAutoReconnect && bleDevice && bleReconnectAttempts < BLE_MAX_RECONNECT_ATTEMPTS) {
            bleReconnectAttempts++;
            const delay = Math.pow(2, bleReconnectAttempts) * 1000; // 指数退避: 2s, 4s, 8s
            console.log(`BLE 将在 ${delay/1000}s 后尝试重连 (${bleReconnectAttempts}/${BLE_MAX_RECONNECT_ATTEMPTS})...`);
            
            setTimeout(async () => {
                if (!bleDevice) return;
                
                try {
                    console.log('BLE 正在重连...');
                    bleServer = await bleDevice.gatt.connect();
                    console.log('BLE GATT 重连成功');
                    
                    // 重新获取服务和特征值
                    const services = await bleServer.getPrimaryServices();
                    for (const service of services) {
                        try {
                            const characteristics = await service.getCharacteristics();
                            for (const char of characteristics) {
                                const props = char.properties;
                                if ((props.write || props.writeWithoutResponse) && !bleTxCharacteristic) {
                                    bleTxCharacteristic = char;
                                }
                                if ((props.notify || props.indicate) && !bleRxCharacteristic) {
                                    bleRxCharacteristic = char;
                                }
                            }
                        } catch(e) {}
                    }
                    
                    // 重新订阅通知
                    if (bleRxCharacteristic) {
                        await bleRxCharacteristic.startNotifications();
                        bleRxCharacteristic.addEventListener('characteristicvaluechanged', handleBleData);
                    }
                    
                    currentMode = 'ble';
                    isConnected = true;
                    bleReconnectAttempts = 0; // 重置重连计数
                    console.log('BLE 重连成功！');
                    
                } catch(err) {
                    console.error('BLE 重连失败:', err.message);
                    // 如果重连失败，触发下一次重连
                    if (bleReconnectAttempts < BLE_MAX_RECONNECT_ATTEMPTS) {
                        onBleDisconnected();
                    } else {
                        console.log('BLE 重连次数已达上限，停止重连');
                        bleReconnectAttempts = 0;
                    }
                }
            }, delay);
        } else if (bleReconnectAttempts >= BLE_MAX_RECONNECT_ATTEMPTS) {
            console.log('BLE 重连次数已达上限，停止重连');
            bleReconnectAttempts = 0;
        }
    }
    
    function startBleKeepalive() {
        stopBleKeepalive();
        // 暂时禁用心跳，Windows Web Bluetooth 不稳定
        // 如果需要启用，取消下面的注释
        /*
        setTimeout(() => {
            if (!bleDevice?.gatt?.connected) return;
            
            bleKeepaliveTimer = setInterval(async () => {
                if (!bleDevice?.gatt?.connected) {
                    stopBleKeepalive();
                    return;
                }
                try {
                    await bleWrite(new Uint8Array([0xAA, 0x00, 0x55]));
                } catch (err) {
                    console.warn('BLE 心跳发送失败:', err.message);
                }
            }, 15000);
        }, 10000);
        */
    }

    function stopBleKeepalive() {
        if (bleKeepaliveTimer) {
            clearInterval(bleKeepaliveTimer);
            bleKeepaliveTimer = null;
        }
    }

    async function bleDisconnect() {
        // 手动断开时禁用自动重连
        bleAutoReconnect = false;
        bleReconnectAttempts = 0;
        
        if (bleRxCharacteristic) {
            try {
                bleRxCharacteristic.removeEventListener('characteristicvaluechanged', handleBleData);
                await bleRxCharacteristic.stopNotifications();
            } catch(e) {}
        }
        if (bleDevice?.gatt?.connected) {
            bleDevice.gatt.disconnect();
        }
        stopBleKeepalive();
        bleDevice = null;
        bleServer = null;
        bleService = null;
        bleTxCharacteristic = null;
        bleRxCharacteristic = null;
        currentMode = null;
        isConnected = false;
    }

    // ========================================
    // BLE 设备扫描
    // ========================================
    async function bleScan(duration = 10000) {
        const devices = [];
        
        try {
            // Web Bluetooth 不支持后台扫描，只能通过 requestDevice 选择
            // 但我们可以提供一个用户友好的方式
            const device = await navigator.bluetooth.requestDevice({
                acceptAllDevices: true,
                optionalServices: BLE_UART_SERVICES
            });
            
            if (device) {
                devices.push({
                    name: device.name || '未知设备',
                    id: device.id,
                    address: device.id,
                    class: 0,
                    type: 'ble'
                });
            }
        } catch(err) {
            if (err.name !== 'NotFoundError') {
                console.error('BLE 扫描失败:', err);
            }
        }
        
        return devices;
    }

    // ========================================
    // 统一的 bluetoothSerial 接口
    // ========================================
    const dualAdapter = {
        // 列出设备
        list: function(success, failure) {
            const devices = [];
            
            // 添加串口选项
            if (hasSerial) {
                devices.push({
                    name: '📟 串口设备 (点击选择COM口)',
                    id: 'web-serial',
                    address: 'web-serial',
                    class: 0,
                    type: 'serial'
                });
            }
            
            // 添加蓝牙选项
            if (hasBluetooth) {
                devices.push({
                    name: '📶 BLE蓝牙设备 (点击扫描)',
                    id: 'web-bluetooth',
                    address: 'web-bluetooth', 
                    class: 0,
                    type: 'ble'
                });
            }
            
            // 添加 Python BLE 桥接器选项
            devices.push({
                name: '🚀 Python BLE 桥接器 (高速)',
                id: 'python-ble',
                address: 'python-ble',
                class: 0,
                type: 'python_ble'
            });
            
            success && success(devices);
        },
        
        // 连接设备
        connect: function(address, success, failure) {
            const connectAsync = async () => {
                try {
                    if (address === 'web-serial' || address === 'serial') {
                        await serialConnect();
                    } else if (address === 'web-bluetooth' || address === 'ble') {
                        await bleConnect();
                    } else if (address === 'python-ble') {
                        await connectPythonBLE();
                    } else {
                        // 默认尝试串口，如果失败则尝试蓝牙
                        try {
                            await serialConnect();
                        } catch(e) {
                            if (hasBluetooth) {
                                await bleConnect();
                            } else {
                                throw e;
                            }
                        }
                    }
                    success && success();
                } catch(err) {
                    failure && failure(err.message || '连接失败');
                }
            };
            connectAsync();
        },
        
        // 连接串口（直接调用）
        connectSerial: function(success, failure) {
            this.connect('web-serial', success, failure);
        },
        
        // 连接BLE（直接调用）
        connectBLE: function(success, failure) {
            this.connect('web-bluetooth', success, failure);
        },
        
        // 直接连接到指定的串口（用于快速重连）
        connectToPort: async function(port, success, failure) {
            try {
                const baudRate = getBaudRate();
                
                await port.open({ 
                    baudRate: baudRate,
                    dataBits: 8,
                    stopBits: 1,
                    parity: 'none'
                });
                
                serialPort = port;
                saveLastSerialPort(port);
                
                currentMode = 'serial';
                isConnected = true;
                
                console.log(`串口已连接（快速重连），波特率: ${baudRate}`);
                
                startSerialReading();
                success && success();
            } catch(err) {
                console.error('串口连接失败:', err);
                failure && failure(err.message);
            }
        },
        
        // 断开连接
        disconnect: function(success, failure) {
            const disconnectAsync = async () => {
                try {
                    if (currentMode === 'serial') {
                        await serialDisconnect();
                    } else if (currentMode === 'ble') {
                        await bleDisconnect();
                    } else if (currentMode === 'python_ble') {
                        if (pythonBridge) {
                            pythonBridge.close();
                            pythonBridge = null;
                        }
                        currentMode = null;
                        isConnected = false;
                    } else if (currentMode === 'esp32') {
                        await esp32Disconnect();
                    }
                    success && success();
                } catch(err) {
                    failure && failure(err.message);
                }
            };
            disconnectAsync();
        },
        
        // 连接 ESP32 WiFi 桥接
        connectESP32: function(url, success, failure) {
            esp32Connect(url)
                .then(() => success && success())
                .catch(err => failure && failure(err.message));
        },
        
        // 发送数据
        write: function(data, success, failure) {
            const writeAsync = async () => {
                try {
                    console.log(`[DEBUG] write called, currentMode=${currentMode}, isConnected=${isConnected}, hasBridge=${hasBridge}`);
                    if (currentMode === 'serial') {
                        await serialWrite(data);
                    } else if (currentMode === 'ble' || currentMode === 'ble-bridge') {
                        await bleWrite(data);
                    } else if (currentMode === 'python_ble') {
                        await pythonBLEWrite(data);
                    } else if (currentMode === 'esp32') {
                        await esp32Write(data);
                    } else {
                        throw new Error('未连接');
                    }
                    success && success();
                } catch(err) {
                    failure && failure(err.message);
                }
            };
            writeAsync();
        },
        
        // 订阅数据（基于分隔符）
        subscribe: function(delim, callback, failure) {
            delimiter = delim;
            subscribeCallback = callback;
        },
        
        // 订阅原始数据
        subscribeRawData: function(callback, failure) {
            rawSubscribeCallback = callback;
        },
        
        // 取消订阅
        unsubscribe: function(success, failure) {
            subscribeCallback = null;
            rawSubscribeCallback = null;
            success && success();
        },
        
        // 检查连接状态
        isConnected: function(success, failure) {
            success && success(isConnected);
        },
        
        // 获取当前连接模式
        getConnectionMode: function() {
            return currentMode;
        },
        
        // 启用（兼容 Cordova）
        enable: function(success, failure) {
            success && success();
        },
        
        // 是否启用（兼容 Cordova）
        isEnabled: function(success, failure) {
            success && success();
        },
        
        // 发现未配对设备（兼容 Cordova）
        discoverUnpaired: function(success, failure) {
            if (hasBridge) {
                onBridgeScanResult = success;
                wsBridge.send(JSON.stringify({ cmd: 'scan' }));
            } else if (hasBluetooth) {
                bleScan().then(devices => success && success(devices));
            } else {
                success && success([]);
            }
        },
        
        // 设置设备发现监听器（兼容 Cordova）
        setDeviceDiscoveredListener: function(callback) {
            console.log('Web 模式：请使用 list() 或点击设备选择');
        },
        
        // 清除设备发现监听器
        clearDeviceDiscoveredListener: function() {},
        
        // 显示蓝牙设置
        showBluetoothSettings: function(success, failure) {
            alert('PC Web 版本说明：\n\n1. 串口设备：点击"串口设备"选择COM口\n2. BLE蓝牙：点击"BLE蓝牙设备"扫描并选择\n\n确保设备已开启并在范围内');
            success && success();
        },
        
        // 可用（兼容）
        available: function(callback) {
            callback(hasSerial || hasBluetooth);
        },
        
        // 清空（兼容）
        clear: function(success, failure) {
            success && success();
        },
        
        // 其他兼容函数
        setName: function(name, s, f) { s && s(); },
        setDiscoverable: function(d, s, f) { s && s(); },
        read: function(s, f) { f && f('请使用 subscribe'); },
        readUntil: function(d, s, f) { this.subscribe(d, s, f); }
    };

    // ========================================
    // 暴露全局接口
    // ========================================
    window.bluetoothSerial = dualAdapter;
    window.bt = dualAdapter;
    
    // 暴露 WebSocket 引用（用于滑台控制等扩展功能）
    Object.defineProperty(window.bt, 'ws', {
        get: function() { return wsBridge || esp32Bridge; }
    });
    
    // 发送 JSON 命令到桥接器
    window.bt.sendCommand = function(cmd) {
        const ws = wsBridge || esp32Bridge;
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(cmd));
            return true;
        }
        return false;
    };
    
    // 额外暴露便捷方法
    window.connectSerial = () => dualAdapter.connectSerial();
    window.connectBLE = () => dualAdapter.connectBLE();
    window.connectESP32 = (url) => dualAdapter.connectESP32(url);
    window.connectWiFi = (url) => dualAdapter.connectESP32(url);  // 别名
    
    console.log('='.repeat(50));
    console.log('🔌 Web 多模适配器已加载');
    console.log('   支持: ' + (hasSerial ? '✓串口 ' : '') + (hasBluetooth ? '✓BLE蓝牙 ' : '') + '✓ESP32 WiFi');
    console.log('   波特率: ' + getBaudRate());
    console.log('   ESP32: connectESP32() 或 esp32Connect()');
    console.log('='.repeat(50));
    
    // 触发 deviceready 事件
    setTimeout(() => {
        document.dispatchEvent(new Event('deviceready'));
        console.log('deviceready 事件已触发');
    }, 100);
    
})();
