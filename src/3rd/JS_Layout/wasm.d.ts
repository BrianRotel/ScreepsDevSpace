// src/wasm.d.ts
declare module '*.wasm' {
    const content: ArrayBuffer;
    export default content;
}
