/**
 * Web Serial API 适配器
 * 将 Web Serial API 封装成与 cordova-plugin-bluetooth-serial 兼容的接口
 */

(function() {
    'use strict';

    // 检查浏览器是否支持 Web Serial API
    if (!navigator.serial) {
        console.warn('此浏览器不支持 Web Serial API');
        return;
    }

    let currentPort = null;
    let reader = null;
    let isConnected = false;
    let subscribeCallback = null;
    let delimiter = '\n';

    // 创建模拟的 bluetoothSerial 对象
    const webSerialAdapter = {
        // 列出设备（Web Serial 需要用户手动选择，无法自动列出）
        list: function(success, failure) {
            // Web Serial API 无法列出设备，返回提示信息
            const mockDevices = [
                {
                    name: '点击连接按钮选择串口',
                    id: 'web-serial-prompt',
                    address: 'web-serial-prompt',
                    class: 0
                }
            ];
            success && success(mockDevices);
        },

        // 连接设备
        connect: function(address, success, failure) {
            // 在 Web Serial 中，我们需要用户手动选择端口
            navigator.serial.requestPort()
                .then(port => {
                    currentPort = port;
                    // 从 localStorage 读取波特率设置
                    let baudRate = 115200;  // 默认波特率
                    try {
                        const settings = JSON.parse(localStorage.getItem('bt_settings') || '{}');
                        baudRate = settings.baudRate || 115200;
                    } catch(e) {}
                    console.log('[WebSerial] 使用波特率:', baudRate);
                    
                    // 打开端口
                    return currentPort.open({ 
                        baudRate: baudRate,
                        dataBits: 8,
                        stopBits: 1,
                        parity: 'none'
                    });
                })
                .then(() => {
                    isConnected = true;
                    console.log('串口已连接');
                    
                    // 启动读取循环
                    startReading();
                    
                    success && success();
                })
                .catch(err => {
                    console.error('连接失败:', err);
                    failure && failure(err.message || '连接失败');
                });
        },

        // 断开连接
        disconnect: function(success, failure) {
            if (!currentPort) {
                success && success();
                return;
            }

            // 停止读取
            if (reader) {
                try {
                    reader.cancel();
                } catch(e) {}
                reader = null;
            }

            // 关闭端口
            currentPort.close()
                .then(() => {
                    isConnected = false;
                    currentPort = null;
                    console.log('串口已断开');
                    success && success();
                })
                .catch(err => {
                    console.error('断开失败:', err);
                    failure && failure(err.message);
                });
        },

        // 发送数据
        write: function(data, success, failure) {
            if (!currentPort || !isConnected) {
                failure && failure('未连接');
                return;
            }

            const writer = currentPort.writable.getWriter();
            
            // 将字符串转换为 Uint8Array
            let bytes;
            if (typeof data === 'string') {
                bytes = new TextEncoder().encode(data);
            } else if (data instanceof ArrayBuffer) {
                bytes = new Uint8Array(data);
            } else {
                bytes = data;
            }

            writer.write(bytes)
                .then(() => {
                    writer.releaseLock();
                    success && success();
                })
                .catch(err => {
                    writer.releaseLock();
                    console.error('写入失败:', err);
                    failure && failure(err.message);
                });
        },

        // 订阅数据（基于分隔符）
        subscribe: function(delim, callback, failure) {
            delimiter = delim;
            subscribeCallback = callback;
        },

        // 订阅原始数据
        subscribeRawData: function(callback, failure) {
            subscribeCallback = callback;
            delimiter = null; // 无分隔符，直接回调
        },

        // 取消订阅
        unsubscribe: function(success, failure) {
            subscribeCallback = null;
            success && success();
        },

        // 检查连接状态
        isConnected: function(success, failure) {
            success && success(isConnected);
        },

        // 模拟启用蓝牙（Web Serial 不需要）
        enable: function(success, failure) {
            success && success();
        },

        // Cordova 插件兼容函数 - discoverUnpaired
        discoverUnpaired: function(success, failure) {
            // Web Serial 不支持设备发现，返回空列表
            success && success([]);
        },

        // Cordova 插件兼容函数 - isEnabled
        isEnabled: function(success, failure) {
            // Web Serial 总是启用的
            success && success();
        },

        // Cordova 插件兼容函数 - available
        available: function(callback) {
            // 检查浏览器是否支持 Web Serial
            callback(!!navigator.serial);
        },

        // Cordova 插件兼容函数 - read
        read: function(success, failure) {
            // 不支持单次读取，使用 subscribe 代替
            failure && failure('请使用 subscribe 方法');
        },

        // Cordova 插件兼容函数 - readUntil
        readUntil: function(delimiter, success, failure) {
            // 使用 subscribe 实现
            this.subscribe(delimiter, success, failure);
        },

        // Cordova 插件兼容函数 - clear
        clear: function(success, failure) {
            // Web Serial 不需要清空缓冲区
            success && success();
        },

        // Cordova 插件兼容函数 - setDeviceDiscoveredListener
        setDeviceDiscoveredListener: function(callback) {
            // Web Serial 不支持设备发现
            console.warn('Web Serial 不支持自动设备发现');
        },

        // Cordova 插件兼容函数 - clearDeviceDiscoveredListener
        clearDeviceDiscoveredListener: function() {
            // 无需操作
        },

        // Cordova 插件兼容函数 - showBluetoothSettings
        showBluetoothSettings: function(success, failure) {
            alert('Web Serial 模式：请点击连接按钮选择串口\n\n确保设备已在 Windows 蓝牙设置中配对并分配了 COM 口');
            success && success();
        },

        // Cordova 插件兼容函数 - setName
        setName: function(name, success, failure) {
            success && success();
        },

        // Cordova 插件兼容函数 - setDiscoverable
        setDiscoverable: function(discoverableDuration, success, failure) {
            success && success();
        }
    };

    // 启动读取循环
    async function startReading() {
        if (!currentPort || !currentPort.readable) return;

        reader = currentPort.readable.getReader();
        let buffer = '';

        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) {
                    // 读取结束
                    reader.releaseLock();
                    break;
                }

                if (!subscribeCallback) continue;

                // 将数据转换为字符串
                const text = new TextDecoder().decode(value);

                if (delimiter === null) {
                    // 原始数据模式
                    subscribeCallback(value.buffer);
                } else {
                    // 基于分隔符模式
                    buffer += text;
                    
                    if (buffer.includes(delimiter)) {
                        const parts = buffer.split(delimiter);
                        // 处理除了最后一个部分之外的所有部分
                        for (let i = 0; i < parts.length - 1; i++) {
                            subscribeCallback(parts[i]);
                        }
                        // 保留最后一个未完成的部分
                        buffer = parts[parts.length - 1];
                    }
                }
            }
        } catch (err) {
            console.error('读取错误:', err);
        } finally {
            if (reader) {
                reader.releaseLock();
                reader = null;
            }
        }
    }

    // 将适配器暴露为全局 bluetoothSerial 对象
    window.bluetoothSerial = webSerialAdapter;
    window.bt = webSerialAdapter; // 同时设置简写
    
    console.log('Web Serial API 适配器已加载');
    
    // 触发 deviceready 事件（模拟 Cordova）
    setTimeout(() => {
        const event = new Event('deviceready');
        document.dispatchEvent(event);
        console.log('deviceready 事件已触发');
    }, 100);
})();
