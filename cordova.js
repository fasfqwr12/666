// PC Web 版 cordova.js
// 标记为非真实 Cordova 环境
window.isWebVersion = true;
window.isPCVersion = true;
console.log('PC Web 版本已加载');

// 动态加载双模适配器
(function() {
    var script = document.createElement('script');
    script.src = 'web-dual-adapter.js';
    script.onload = function() {
        console.log('双模适配器加载完成');
    };
    script.onerror = function() {
        console.error('双模适配器加载失败');
    };
    document.head.appendChild(script);
})();

// 添加 PC 专用样式
(function() {
    var style = document.createElement('style');
    style.textContent = `
        /* PC 端优化样式 */
        @media (min-width: 768px) {
            body {
                max-width: 1400px;
                margin: 0 auto;
                background: #e5e7eb;
            }
            
            .app-container {
                display: grid;
                grid-template-columns: 300px 1fr;
                gap: 16px;
                padding: 16px;
                min-height: 100vh;
            }
            
            /* 左侧设备面板 */
            .device-panel {
                background: white;
                border-radius: 12px;
                padding: 16px;
                box-shadow: 0 2px 8px rgba(0,0,0,0.1);
                height: fit-content;
                position: sticky;
                top: 16px;
            }
            
            /* 主内容区 */
            .main-content {
                background: white;
                border-radius: 12px;
                padding: 16px;
                box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            }
            
            /* 按钮放大 */
            button, .btn {
                min-height: 40px;
                font-size: 14px;
                cursor: pointer;
            }
            
            button:hover, .btn:hover {
                opacity: 0.9;
                transform: translateY(-1px);
            }
            
            /* 输入框放大 */
            input, select, textarea {
                min-height: 38px;
                font-size: 14px;
            }
            
            /* 表格优化 */
            table {
                width: 100%;
            }
            
            th, td {
                padding: 12px 8px;
            }
            
            /* 设备卡片 */
            .device-item, .device-card {
                padding: 12px;
                margin: 8px 0;
                border-radius: 8px;
                cursor: pointer;
                transition: all 0.2s;
            }
            
            .device-item:hover, .device-card:hover {
                background: #f0f7ff;
                transform: translateX(4px);
            }
            
            /* Tab 标签优化 */
            .tabs, .tab-bar {
                display: flex;
                gap: 8px;
                border-bottom: 2px solid #e5e7eb;
                padding-bottom: 8px;
            }
            
            .tab, .tab-item {
                padding: 10px 20px;
                cursor: pointer;
                border-radius: 8px 8px 0 0;
                transition: all 0.2s;
            }
            
            .tab:hover, .tab-item:hover {
                background: #f0f7ff;
            }
            
            .tab.active, .tab-item.active {
                background: var(--primary, #1976d2);
                color: white;
            }
            
            /* 日志区域 */
            .log-container, #log-container, .data-log {
                font-family: 'Consolas', 'Monaco', monospace;
                font-size: 13px;
                line-height: 1.5;
                max-height: 400px;
                overflow-y: auto;
            }
            
            /* 波形图 */
            canvas {
                width: 100% !important;
                height: 300px !important;
            }
            
            /* 命令输入区 */
            .command-input, .send-area {
                display: flex;
                gap: 8px;
                align-items: center;
            }
            
            .command-input input, .send-area input {
                flex: 1;
            }
            
            /* 工具栏 */
            .toolbar {
                display: flex;
                gap: 8px;
                flex-wrap: wrap;
                padding: 8px 0;
                border-bottom: 1px solid #e5e7eb;
                margin-bottom: 16px;
            }
        }
        
        /* PC 端专用提示 */
        .pc-hint {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 12px 16px;
            border-radius: 8px;
            margin-bottom: 16px;
            font-size: 14px;
        }
        
        .pc-hint a {
            color: #ffd700;
            text-decoration: underline;
        }
        
        /* PC 端导航和布局优化 */
        @media (min-width: 768px) {
            .tab-bar button {
                padding: 14px 36px !important;
                font-size: 15px !important;
            }
            
            main {
                padding: 24px !important;
                max-width: 1200px !important;
                margin: 0 auto !important;
            }
            
            .section {
                padding: 20px !important;
                margin-bottom: 20px !important;
            }
            
            h2 {
                font-size: 18px !important;
            }
            
            .device-toolbar {
                display: flex !important;
                gap: 12px !important;
                align-items: center !important;
            }
            
            .device-toolbar input {
                min-width: 200px !important;
            }
            
            .send-bar, .input-group {
                display: flex !important;
                gap: 12px !important;
            }
            
            .send-bar input, .input-group input {
                flex: 1 !important;
            }
            
            textarea {
                min-height: 100px !important;
            }
        }
    `;
    document.head.appendChild(style);
})();
