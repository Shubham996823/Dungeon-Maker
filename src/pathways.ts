import type { Room, RoomConnection, PlanPoint } from "./types";
import type { ConnectionGeometry } from "./roomConnections";
export type PathPoint = PlanPoint & { elevation:number };

export function resolvePathPoints(connection:RoomConnection, rooms:Room[]):PathPoint[] {
  const points=(connection.pathPoints??[]).map(p=>({...p}));
  const from=rooms.find(r=>r.id===connection.fromRoomId);
  const start=from?.openings.find(o=>o.id===connection.fromOpeningId && !o.suppressed);
  if(start && from && connection.pathOrigin) {
    const dx=start.cx-connection.pathOrigin.x,dy=start.cy-connection.pathOrigin.y,dh=(from.elevationSteps??0)*0.25-connection.pathOrigin.elevation;
    points.forEach(p=>{p.x+=dx;p.y+=dy;p.elevation+=dh;});
    points[0]={x:start.cx,y:start.cy,elevation:(from.elevationSteps??0)*0.25};
  }
  const to=rooms.find(r=>r.id===connection.toRoomId);
  const end=to?.openings.find(o=>o.id===connection.toOpeningId && !o.suppressed);
  if(end && to && points.length) points[points.length-1]={x:end.cx,y:end.cy,elevation:(to.elevationSteps??0)*0.25};
  return points;
}

export function pathwayGeometry(points:PathPoint[], broken:number[]=[]):ConnectionGeometry & { invalidSegments:number[] } {
  const result:ConnectionGeometry & {invalidSegments:number[]}={stairFlights:[],floorTiles:[],invalidSegments:[]};
  // A bend is a full-width landing, not two strips ending at their centre lines.
  // Trim both adjoining strips to its edges to avoid coplanar overlapping floors.
  const corners=new Map<number,number>();
  for(let i=1;i<points.length-1;i++) {
    if(broken.includes(i-1)||broken.includes(i))continue;
    const a=points[i-1],b=points[i],c=points[i+1];
    const ax=b.x-a.x,ay=b.y-a.y,bx=c.x-b.x,by=c.y-b.y;
    const al=Math.hypot(ax,ay),bl=Math.hypot(bx,by);
    if(al>=2&&bl>=2&&Math.abs((ax*bx+ay*by)/(al*bl))<1e-5)corners.set(i,Math.atan2(ay,ax));
  }
  for(let i=0;i<points.length-1;i++) {
    if(broken.includes(i)) continue;
    const a=points[i],b=points[i+1],length=Math.hypot(b.x-a.x,b.y-a.y),rise=Math.abs(b.elevation-a.elevation);
    const flights=Math.round(rise/1.25),run=flights*1.25;
    if(length<0.01 || Math.abs(rise-flights*1.25)>0.001 || (flights && length<run+2)) {result.invalidSegments.push(i);continue;}
    const ux=(b.x-a.x)/length,uy=(b.y-a.y)/length;
    const low=a.elevation<=b.elevation?a:b,sign=low===a?1:-1;
    const rotation=Math.atan2(uy*sign,ux*sign)-Math.PI/2;
    const floor=(from:number,to:number,elevation:number)=>{
      from=Math.max(from,corners.has(i)?1:0);
      to=Math.min(to,length-(corners.has(i+1)?1:0));
      if(to-from<1e-6)return;
      const count=Math.max(1,Math.ceil((to-from)/2));
      for(let j=0;j<count;j++) {
        const step=(to-from)/count,d=from+(j+0.5)*step;
        result.floorTiles.push({point:{x:a.x+ux*d,y:a.y+uy*d},elevation,rotation:Math.atan2(uy,ux),length:step,segmentIndex:i});
      }
    };
    if(!flights) floor(0,length,a.elevation);
    else {
      const start=(length-run)/2;
      floor(0,start,a.elevation);floor(start+run,length,b.elevation);
      for(let j=0;j<flights;j++) {
        const d=start+(j+0.5)*1.25;
        result.stairFlights.push({point:{x:low.x+ux*sign*d,y:low.y+uy*sign*d},elevation:low.elevation+j*1.25,rotation,segmentIndex:i});
      }
    }
  }
  for(const [index,rotation] of corners) {
    if(result.invalidSegments.includes(index-1)||result.invalidSegments.includes(index))continue;
    const p=points[index];
    result.floorTiles.push({point:{x:p.x,y:p.y},elevation:p.elevation,rotation,length:2,segmentIndex:index});
  }
  return result;
}

export function deletePathPoint(connection:RoomConnection,index:number):RoomConnection {
  const points=connection.pathPoints??[];
  if(index<=0 || index>=points.length-1) return connection;
  const broken=new Set<number>();
  for(const segment of connection.brokenSegments??[]) broken.add(segment>=index?segment-1:segment);
  return {...connection,pathPoints:points.filter((_,i)=>i!==index),brokenSegments:[...broken]};
}

export function insertPathPoint(connection:RoomConnection,index:number):RoomConnection {
  const points=connection.pathPoints??[],a=points[index],b=points[index+1];
  if(!a||!b) return connection;
  const broken=(connection.brokenSegments??[]).flatMap(i=>i===index?[i,i+1]:[i>index?i+1:i]);
  return {...connection,pathPoints:[...points.slice(0,index+1),{x:(a.x+b.x)/2,y:(a.y+b.y)/2,elevation:a.elevation+Math.round((b.elevation-a.elevation)/2/1.25)*1.25},...points.slice(index+1)],brokenSegments:broken};
}
