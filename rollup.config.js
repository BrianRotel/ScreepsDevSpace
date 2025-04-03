import clear from 'rollup-plugin-clear'
import screeps from 'rollup-plugin-screeps'
import copy from 'rollup-plugin-copy'
import typescript from 'rollup-plugin-typescript2'
import resolve from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import wasm from '@rollup/plugin-wasm';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);

let config
if (!process.env.DEST) console.log("未指定目标, 代码将被编译但不会上传")
else if (!(config = require("./.secret.json")[process.env.DEST])) {
    throw new Error("无效目标，请检查 secret.json 中是否包含对应配置")
}

// 根据指定的配置决定是上传还是复制到文件夹
const pluginDeploy = config && config.copyPath ?
    // 复制到指定路径
    copy({
        targets: [
            {
                src: 'dist/main.js',
                dest: config.copyPath
            },
            {
                src: 'dist/main.js.map',
                dest: config.copyPath,
                rename: name => name + '.map.js',
                transform: contents => `module.exports = ${contents.toString()};`
            },
            // 新增：复制所有 .wasm 文件
            {
                src: 'dist/*.wasm', // 匹配任意哈希的 .wasm 文件
                dest: config.copyPath
            }
        ],
        hook: 'writeBundle',
        verbose: true
    }) :
    // 更新 .map 到 .map.js 并上传
    screeps({config, dryRun: !config})

export default {
    input: 'src/main.ts',
    output: {
        file: 'dist/main.js',
        format: 'cjs',
        sourcemap: true,
    },
    plugins: [
        // 清除上次编译成果
        clear({targets: ["dist"]}),
        // 打包依赖
        resolve(),
        // 模块化依赖
        commonjs(),
        // 编译 ts
        typescript({tsconfig: "./tsconfig.json"}),

        wasm({
            // 固定输出文件名
            fileName: 'algo_wasm_priorityqueue.wasm',
            // 关键配置：强制内联 WASM 文件
            maxFileSize: 0,
            //targetEnv: 'auto', // 自动检测环境（浏览器/Node.js）
            // 空字符串表示相对路径
            publicPath: '',
            // 同步加载（确保直接获取 ArrayBuffer）
            sync: [],
            // 显式包含 WASM 文件
            include: ['**/*.wasm'],
            // 调试时开启，查看二进制内联结果
            hexdump: true
        }),

        // 执行上传或者复制
        pluginDeploy
    ]
};
