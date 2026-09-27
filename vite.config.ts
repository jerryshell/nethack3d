import { defineConfig } from 'vite';

export default defineConfig({
  // 相对路径：产物可以放在任意子目录或直接用文件协议打开。
  base: './',

  // 不清屏：保留启动前的输出，人工与 Agent 回看日志时不用重跑。
  clearScreen: false,

  server: {
    port: 5273,
    // 端口被占用时直接报错。默认行为是静默改用下一个端口，
    // 自动化脚本会连上一个不知道是什么的服务。
    strictPort: true,
    open: false,
  },

  // 与开发服务器同端口，方便替换验证生产产物。
  preview: {
    port: 5273,
    strictPort: true,
  },

  build: {
    // 显式声明支持范围。实测 es2022、esnext 与 Vite 默认的
    // baseline-widely-available 三者产物完全一致，因此保留最保守的取值。
    target: 'es2022',
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        // three.js 体积较大且很少变动，单独分包便于缓存。
        manualChunks: { three: ['three'] },
      },
    },
  },
});
