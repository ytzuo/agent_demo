const BASE_URL = 'http://localhost:3000';

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 通用聊天测试函数
async function testChat(user, message, personaId) {
    console.log(`\n[${user}] 正在发送给 ${personaId}: "${message}"`);
    const start = Date.now();
    try {
        const response = await fetch(`${BASE_URL}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: user,
                message: message,
                personaId: personaId
            })
        });
        
        const data = await response.json();
        const duration = ((Date.now() - start) / 1000).toFixed(2);
        
        if (response.ok) {
            console.log(`✅ [${user}] 收到回复 (${duration}s):`);
            console.log(`   排队状态: 前方还有 ${data.queueStatus?.length || 0} 人`);
            console.log(`   Agent回复: ${data.reply.substring(0, 100)}${data.reply.length > 100 ? '...' : ''}`);
        } else {
            console.log(`❌ [${user}] 请求失败 (${response.status}):`, data);
        }
    } catch (error) {
        console.error(`❌ [${user}] 网络错误:`, error.message);
    }
}

// 剧场模式测试函数
async function testTheater() {
    console.log('\n🎬 [Theater] 正在启动小剧场 (Math Teacher vs Poet)...');
    const start = Date.now();
    try {
        const response = await fetch(`${BASE_URL}/theater`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                personaA: 'math-teacher',
                personaB: 'poet',
                topic: '简单探讨圆周率有什么意义',
                turns: 2 // 两轮对话
            })
        });
        const data = await response.json();
        const duration = ((Date.now() - start) / 1000).toFixed(2);
        
        if (response.ok) {
            console.log(`✅ [Theater] 剧场结束 (${duration}s). 剧本如下:\n`);
            data.script.forEach(line => {
                console.log(`[${line.speaker}]: ${line.content.substring(0, 100)}...`);
            });
        } else {
            console.log(`❌ [Theater] 失败:`, data);
        }
    } catch (error) {
        console.error(`❌ [Theater] 网络错误:`, error.message);
    }
}

async function runTests() {
    // 检查服务是否运行
    try {
        await fetch(BASE_URL + '/personas');
    } catch (e) {
        console.error("❌ 无法连接到服务器，请确保先运行了 'npm start' 并且端口为 3000");
        return;
    }

    console.log('=== 1. 测试基础对话 (串行) ===');
    await testChat('user1', '你好，这也是一个测试请求', 'math-teacher');

    console.log('\n=== 2. 测试并发排队 (并行) ===');
    console.log('说明: 将同时发送两个请求给 math-teacher，你应该观察到其中一个需要等待另一个完成。');
    
    // 同时发起两个请求
    const p1 = testChat('userA', '请解释量子力学（简短点）', 'math-teacher');
    // 稍微延迟一点点，确保顺序方便观察，但要在 p1 结束前发起
    await delay(200); 
    const p2 = testChat('userB', '1+1等于几？', 'math-teacher');
    
    await Promise.all([p1, p2]);

    console.log('\n=== 3. 测试不同 Persona 并发 (互不影响) ===');
    console.log('说明: 同时请求 math-teacher 和 poet，它们应该并行处理，不需要排队。');
    const p3 = testChat('userC', '圆周率是怎么来的？', 'math-teacher');
    const p4 = testChat('userD', '写一首关于春天的短诗', 'poet');
    await Promise.all([p3, p4]);

    console.log('\n=== 4. 测试剧场模式 ===');
    await testTheater();
}

runTests();
