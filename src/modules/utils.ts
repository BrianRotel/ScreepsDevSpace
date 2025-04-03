import { forEach } from 'lodash';



/**
 * 显示 hello world
 */
export const sayHello = function () {
    //console.log('hello world! GameTime:'+Game.time /*+ " cpu:"+Game.cpu.bucket*/)
    //throw new Error('我是 sayHello 里的报错')
}
//危险操作
export const cleanMemory = function () {
    RawMemory.set(JSON.stringify({}));
}
export const visualizeTerrain = function (roomName: string) {
    const terrain = Game.map.getRoomTerrain(roomName);
    const visual = new RoomVisual(roomName);

    visual.text('🚨 危险区域!',  25,25, {
            color: '#ff3300',
            backgroundColor: '#00000', // 背景色
            backgroundPadding: 0.1, // 背景边距
            strokeWidth:7      // 字号（单位：格高度比例）
        });

    // 标记所有房间的矿点
    forEach(Game.rooms, room => {
        console.log("Current room", room)

        // 逻辑代码
        const sources = room.find(FIND_SOURCES);

        console.log("Current sources", sources)
        const mineral = room.find(FIND_MINERALS);
        console.log("Current mineral", mineral.pop().pos)
        const structure = room.find(FIND_STRUCTURES).filter(s => s.structureType === STRUCTURE_CONTROLLER) ;
        console.log("Current structure", structure.pop().pos)


        sources.forEach(source => {
            console.log("Current source", source.pos)
            visual.circle(source.pos, {
                    radius: 1,
                    fill: '#ffff00',
                    opacity: 0.3
                })
                .text(`⛏️ ${source.energy}/${source.energyCapacity}`, source.pos.x, source.pos.y,{
                    align: 'center'
                });
        });
    });
    // let map = "";
    // for (let y = 0; y < 50; y++) {
    //     for (let x = 0; x < 50; x++) {
    //         const tile = terrain.get(x, y);
    //         map += tile === TERRAIN_MASK_WALL ? "▓▓" : tile === TERRAIN_MASK_SWAMP ? "**" : "  ";
    //     }
    //     map += "\n";
    // }
    //console.log(`Terrain map for ${roomName}:\n${map}`);
}
