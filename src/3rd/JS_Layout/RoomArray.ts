import { RoomArrayTypes } from '../../../src/types';

export default class RoomArray {
    private arr: number[]; // 存储数据的核心数组

    constructor() {
        this.arr = new Array(50 * 50).fill(0); // 初始化时直接填充数组
    }

    // 核心操作方法
    public exec(x: number, y: number, val: number): number {
        const tmp = this.get(x, y);
        this.set(x, y, val);
        return tmp;
    }

    public get(x: number, y: number): number {
        return this.arr[x * 50 + y];
    }

    public set(x: number, y: number, value: number): void {
        this.arr[x * 50 + y] = value;
    }

    // 初始化/重置数组
    public init(): this {
        this.arr.fill(0);
        return this;
    }

    // 调试输出
    public print(): void {
        console.log(this.arr.toString());
    }

    // 遍历方法
    public forEach(func: RoomArrayTypes.PositionCallback): void {
        for (let y = 0; y < 50; y++) {
            for (let x = 0; x < 50; x++) {
                func(x, y, this.get(x, y));
            }
        }
    }

    // 四方向遍历
    public for4Direction(func: RoomArrayTypes.PositionCallback, x: number, y: number): void {
        const directions: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (const [dx, dy] of directions) {
            const xt = x + dx;
            const yt = y + dy;
            if (xt >= 0 && yt >= 0 && xt < 50 && yt < 50) {
                func(xt, yt, this.get(xt, yt));
            }
        }
    }

    // 周围范围遍历
    public forNear(
        func: RoomArrayTypes.PositionCallback,
        x: number,
        y: number,
        range: number = 1
    ): void {
        for (let i = -range; i <= range; i++) {
            for (let j = -range; j <= range; j++) {
                if (i === 0 && j === 0) continue; // 跳过自身
                const xt = x + i;
                const yt = y + j;
                if (xt >= 0 && yt >= 0 && xt < 50 && yt < 50) {
                    func(xt, yt, this.get(xt, yt));
                }
            }
        }
    }

    // 边界遍历
    public forBorder(func: RoomArrayTypes.PositionCallback): void {
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
    public initRoomTerrainWalkAble(roomName: string): void {
        const terrain = new Room.Terrain(roomName);
        this.forEach((x, y) => {
            const value = terrain.get(x, y);
            // 转换地形值：平地（0）-> 1，墙（1）-> 0，其他保持原值
            this.set(x, y, value === TERRAIN_MASK_WALL ? 0 : value === TERRAIN_MASK_SWAMP ? 2 : 1);
        });
    }
}

