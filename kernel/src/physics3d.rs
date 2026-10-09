//! Native Rapier 3D bridge. JSON is only the host boundary; simulation remains in Rust.
use rapier3d::na::{Quaternion, UnitQuaternion};
use rapier3d::prelude::*;
use rapier3d::control::{KinematicCharacterController, CharacterAutostep, CharacterLength};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    ffi::CString,
    sync::{Mutex, OnceLock},
};
struct World {
    gravity: Vector<f32>,
    params: IntegrationParameters,
    pipeline: PhysicsPipeline,
    islands: IslandManager,
    broad: DefaultBroadPhase,
    narrow: NarrowPhase,
    bodies: RigidBodySet,
    colliders: ColliderSet,
    joints: ImpulseJointSet,
    multibody: MultibodyJointSet,
    ccd: CCDSolver,
    query: QueryPipeline,
    handles: HashMap<u32, RigidBodyHandle>,
    next: u32,
    contacts: HashSet<(u32, u32)>,
}
impl World {
    fn new(g: Vector<f32>) -> Self {
        Self {
            gravity: g,
            params: IntegrationParameters::default(),
            pipeline: PhysicsPipeline::new(),
            islands: IslandManager::new(),
            broad: DefaultBroadPhase::new(),
            narrow: NarrowPhase::new(),
            bodies: RigidBodySet::new(),
            colliders: ColliderSet::new(),
            joints: ImpulseJointSet::new(),
            multibody: MultibodyJointSet::new(),
            ccd: CCDSolver::new(),
            query: QueryPipeline::new(),
            handles: HashMap::new(),
            next: 1,
            contacts: HashSet::new(),
        }
    }
    fn handle(&self, id: u32) -> Result<RigidBodyHandle, String> {
        self.handles
            .get(&id)
            .copied()
            .ok_or("Unknown 3D body".into())
    }
    fn pose(&self, id: u32, h: RigidBodyHandle) -> Value {
        let b = &self.bodies[h];
        let p = b.translation();
        let q = b.rotation().quaternion();
        let v = b.linvel();
        json!({"id":id,"position":{"x":p.x,"y":p.y,"z":p.z},"rotation":{"x":q.i,"y":q.j,"z":q.k,"w":q.w},"velocity":{"x":v.x,"y":v.y,"z":v.z}})
    }
    fn call(&mut self, c: &Value) -> Result<Value, String> {
        match c["op"].as_str().unwrap_or("") {
            "createBody" => {
                let o = &c["options"];
                let p = vec(&o["position"], vector![0.0, 0.0, 0.0])?;
                let kind = o["type"].as_str().unwrap_or("dynamic");
                let mut b = match kind {
                    "fixed" => RigidBodyBuilder::fixed(),
                    "kinematic" => RigidBodyBuilder::kinematic_position_based(),
                    "dynamic" => RigidBodyBuilder::dynamic(),
                    _ => return Err("Invalid body type".into()),
                }
                .translation(p)
                .ccd_enabled(o["ccd"].as_bool().unwrap_or(false));
                if let Some(q) = c["rotation"].as_array() {
                    if q.len() != 4 {
                        return Err("Invalid quaternion".into());
                    }
                    let q = Quaternion::new(
                        num(&q[3], 1.0)?,
                        num(&q[0], 0.0)?,
                        num(&q[1], 0.0)?,
                        num(&q[2], 0.0)?,
                    );
                    if q.norm() < 1e-8 {
                        return Err("Zero quaternion".into());
                    }
                    b = b.position(Isometry::from_parts(
                        Translation::from(p),
                        UnitQuaternion::new_normalize(q),
                    ));
                }
                let shape = &o["shape"];
                let positive = |v: &Value| -> Result<f32, String> {
                    let n = num(v, 0.0)?;
                    if n <= 0.0 {
                        return Err("Invalid collider dimension".into());
                    }
                    Ok(n)
                };
                let mut collider = match shape["kind"].as_str().unwrap_or("") {
                    "box" => {
                        let e = &shape["halfExtents"];
                        ColliderBuilder::cuboid(
                            positive(&e[0])?,
                            positive(&e[1])?,
                            positive(&e[2])?,
                        )
                    }
                    "sphere" => ColliderBuilder::ball(positive(&shape["radius"])?),
                    "capsule" => {
                        let height = num(&shape["halfHeight"], 0.0)?;
                        if height < 0.0 {
                            return Err("Invalid capsule height".into());
                        }
                        ColliderBuilder::capsule_y(height, positive(&shape["radius"])?)
                    }
                    "trimesh" => {
                        if kind != "fixed" {
                            return Err("Triangle meshes must be fixed".into());
                        }
                        let vertices = shape["vertices"]
                            .as_array()
                            .ok_or("Missing mesh vertices")?;
                        let indices = shape["indices"].as_array().ok_or("Missing mesh indices")?;
                        if vertices.is_empty()
                            || vertices.len() % 3 != 0
                            || indices.is_empty()
                            || indices.len() % 3 != 0
                        {
                            return Err("Invalid collision mesh".into());
                        }
                        let mut points = Vec::new();
                        for p in vertices.chunks(3) {
                            points.push(point![
                                num(&p[0], 0.0)?,
                                num(&p[1], 0.0)?,
                                num(&p[2], 0.0)?
                            ]);
                        }
                        let mut triangles = Vec::new();
                        for p in indices.chunks(3) {
                            let ids = [id(&p[0])?, id(&p[1])?, id(&p[2])?];
                            if ids.iter().any(|i| *i as usize >= points.len()) {
                                return Err("Mesh index out of bounds".into());
                            }
                            triangles.push(ids);
                        }
                        ColliderBuilder::trimesh(points, triangles)
                    }
                    _ => return Err("Unknown collider shape".into()),
                };
                let friction = num(&o["friction"], 0.5)?;
                let restitution = num(&o["restitution"], 0.0)?;
                let density = num(&o["density"], 1.0)?;
                if friction < 0.0 || restitution < 0.0 || density < 0.0 {
                    return Err("Invalid collider material".into());
                }
                collider = collider
                    .sensor(o["sensor"].as_bool().unwrap_or(false))
                    .friction(friction)
                    .restitution(restitution)
                    .density(density);
                if !o["groups"].is_null() {
                    let groups = id(&o["groups"])?;
                    collider = collider.collision_groups(InteractionGroups::new(
                        Group::from_bits_truncate(groups >> 16),
                        Group::from_bits_truncate(groups & 65535),
                    ));
                }
                let h = self.bodies.insert(b);
                self.colliders
                    .insert_with_parent(collider, h, &mut self.bodies);
                let id = self.next;
                self.next += 1;
                self.handles.insert(id, h);
                Ok(self.pose(id, h))
            }
            "step" => {
                let dt = num(&c["dt"], 0.0)?;
                if dt <= 0.0 || dt > 0.1 {
                    return Err("Invalid 3D step".into());
                }
                self.params.dt = dt;
                self.pipeline.step(
                    &self.gravity,
                    &self.params,
                    &mut self.islands,
                    &mut self.broad,
                    &mut self.narrow,
                    &mut self.bodies,
                    &mut self.colliders,
                    &mut self.joints,
                    &mut self.multibody,
                    &mut self.ccd,
                    Some(&mut self.query),
                    &(),
                    &(),
                );
                let ids: HashMap<_, _> = self.handles.iter().map(|(id, h)| (*h, *id)).collect();
                let mut contacts = HashSet::new();
                let mut record = |a: ColliderHandle, b: ColliderHandle| {
                    if let (Some(a), Some(b)) = (
                        self.colliders[a].parent().and_then(|h| ids.get(&h)),
                        self.colliders[b].parent().and_then(|h| ids.get(&h)),
                    ) {
                        contacts.insert(((*a).min(*b), (*a).max(*b)));
                    }
                };
                for pair in self.narrow.contact_pairs() {
                    if pair.has_any_active_contact {
                        record(pair.collider1, pair.collider2);
                    }
                }
                for (a, b, intersecting) in self.narrow.intersection_pairs() {
                    if intersecting {
                        record(a, b);
                    }
                }
                let mut events = Vec::new();
                for (a, b) in contacts.difference(&self.contacts) {
                    events.push(json!([a, b, true]));
                }
                for (a, b) in self.contacts.difference(&contacts) {
                    events.push(json!([a, b, false]));
                }
                self.contacts = contacts;
                Ok(
                    json!({"poses":self.handles.iter().map(|(id,h)|self.pose(*id,*h)).collect::<Vec<_>>(),"events":events}),
                )
            }
            "removeBody" => {
                let id = id(&c["body"])?;
                let h = self.handle(id)?;
                self.handles.remove(&id);
                self.bodies.remove(
                    h,
                    &mut self.islands,
                    &mut self.colliders,
                    &mut self.joints,
                    &mut self.multibody,
                    true,
                );
                Ok(Value::Null)
            }
            "characterMove" => {
                let h = self.handle(id(&c["body"])?)?;
                let dt = num(&c["dt"], 0.0)?;
                let step = num(&c["stepHeight"], 0.0)?;
                let snap = num(&c["snapDistance"], 0.0)?;
                let slope = num(&c["maxSlope"], std::f32::consts::FRAC_PI_4)?;
                if dt <= 0.0 || dt > 0.1 || step < 0.0 || snap < 0.0 || !(0.0..std::f32::consts::FRAC_PI_2).contains(&slope) {
                    return Err("Invalid character step".into());
                }
                if !self.bodies[h].is_kinematic() { return Err("Character body must be kinematic".into()); }
                self.bodies.propagate_modified_body_positions_to_colliders(&mut self.colliders);
                self.query.update(&self.colliders);
                let collider = *self.bodies[h].colliders().first().ok_or("Character collider missing")?;
                let shape = self.colliders[collider].shared_shape().clone();
                let position = *self.colliders[collider].position();
                let desired = vec(&c["desired"], Vector::zeros())?;
                let controller = KinematicCharacterController {
                    offset: CharacterLength::Absolute(0.015),
                    max_slope_climb_angle: slope,
                    min_slope_slide_angle: slope + 0.04,
                    autostep: if step > 0.0 { Some(CharacterAutostep {max_height:CharacterLength::Absolute(step),min_width:CharacterLength::Absolute(0.15),include_dynamic_bodies:false}) } else {None},
                    snap_to_ground: if snap > 0.0 {Some(CharacterLength::Absolute(snap))}else{None},
                    ..Default::default()
                };
                let filter = QueryFilter::default().exclude_rigid_body(h).exclude_sensors();
                let mut collisions = Vec::new();
                let movement = controller.move_shape(dt,&self.bodies,&self.colliders,&self.query,shape.as_ref(),&position,desired,filter,|hit|collisions.push(hit));
                controller.solve_character_collision_impulses(dt,&mut self.bodies,&self.colliders,&self.query,shape.as_ref(),75.0,&collisions,filter);
                let v=movement.translation;
                Ok(json!({"movement":{"x":v.x,"y":v.y,"z":v.z},"grounded":movement.grounded}))
            }
            "velocity" | "impulse" | "target" | "translation" => {
                let h = self.handle(id(&c["body"])?)?;
                let v = vec(&c["value"], vector![0.0, 0.0, 0.0])?;
                let b = &mut self.bodies[h];
                match c["op"].as_str().unwrap() {
                    "velocity" => b.set_linvel(v, true),
                    "impulse" => b.apply_impulse(v, true),
                    "translation" => b.set_translation(v, true),
                    _ => b.set_next_kinematic_translation(v),
                };
                self.bodies.propagate_modified_body_positions_to_colliders(&mut self.colliders);
                Ok(Value::Null)
            }
            "raycast" => {
                let o = vec(&c["origin"], vector![0.0, 0.0, 0.0])?;
                let d = vec(&c["direction"], vector![0.0, 0.0, 0.0])?;
                let distance = num(&c["distance"], 0.0)?;
                if d.norm() < 1e-8 || distance < 0.0 {
                    return Err("Invalid ray".into());
                }
                self.bodies.propagate_modified_body_positions_to_colliders(&mut self.colliders);
                self.query.update(&self.colliders);
                let mut filter = QueryFilter::default();
                if !c["ignore"].is_null() { if let Some(h)=self.handles.get(&id(&c["ignore"])?) {filter=filter.exclude_rigid_body(*h);} }
                Ok(
                    match self.query.cast_ray_and_get_normal(
                        &self.bodies,
                        &self.colliders,
                        &Ray::new(o.into(), d.normalize()),
                        distance,
                        true,
                        filter,
                    ) {
                        None => Value::Null,
                        Some((collider, hit)) => {
                            let body = self.colliders[collider].parent().and_then(|h| {
                                self.handles.iter().find(|(_, v)| **v == h).map(|(i, _)| *i)
                            });
                            json!({"collider":{"handle":body},"body":body,"timeOfImpact":hit.time_of_impact,"normal":{"x":hit.normal.x,"y":hit.normal.y,"z":hit.normal.z}})
                        }
                    },
                )
            }
            "stats" => Ok(
                json!({"bodies":self.bodies.len(),"colliders":self.colliders.len(),"joints":self.joints.len()}),
            ),
            _ => Err("Unknown physics3D operation".into()),
        }
    }
}
fn num(v: &Value, default: f32) -> Result<f32, String> {
    if v.is_null() {
        return Ok(default);
    }
    let n = v.as_f64().ok_or("Expected physics number")? as f32;
    if !n.is_finite() {
        return Err("Non-finite physics number".into());
    }
    Ok(n)
}
fn vec(v: &Value, default: Vector<f32>) -> Result<Vector<f32>, String> {
    if v.is_null() {
        return Ok(default);
    }
    Ok(vector![
        num(&v["x"], 0.0)?,
        num(&v["y"], 0.0)?,
        num(&v["z"], 0.0)?
    ])
}
fn id(v: &Value) -> Result<u32, String> {
    let n = v.as_u64().ok_or("Expected physics ID")?;
    if n > u32::MAX as u64 {
        return Err("Physics ID out of range".into());
    }
    Ok(n as u32)
}
struct Registry {
    worlds: HashMap<u32, World>,
    next: u32,
    output: CString,
}
static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
fn registry() -> &'static Mutex<Registry> {
    REGISTRY.get_or_init(|| {
        Mutex::new(Registry {
            worlds: HashMap::new(),
            next: 1,
            output: CString::new("null").unwrap(),
        })
    })
}
pub fn call(json_text: &str) -> String {
    let result = (|| -> Result<Value, String> {
        if json_text.len() > 16 * 1024 * 1024 {
            return Err("Physics command too large".into());
        }
        let c: Value = serde_json::from_str(json_text).map_err(|e| e.to_string())?;
        let mut r = registry().lock().map_err(|_| "Physics registry poisoned")?;
        let op = c["op"].as_str().unwrap_or("");
        if op == "create" {
            let g = vec(&c["gravity"], vector![0.0, -9.81, 0.0])?;
            let id = r.next;
            r.next += 1;
            r.worlds.insert(id, World::new(g));
            return Ok(json!(id));
        }
        let id = id(&c["world"])?;
        if op == "dispose" {
            r.worlds.remove(&id);
            return Ok(Value::Null);
        }
        r.worlds
            .get_mut(&id)
            .ok_or("Unknown physics3D world")?
            .call(&c)
    })();
    match result {
        Ok(value) => json!({"value":value}),
        Err(error) => json!({"error":error}),
    }
    .to_string()
}
/// # Safety
/// input must contain len readable UTF-8 bytes. Output is valid until the next bridge call.
#[no_mangle]
pub unsafe extern "C" fn blackiron_physics3d_json(
    input: *const u8,
    len: u32,
) -> *const std::ffi::c_char {
    if input.is_null() || len > 16 * 1024 * 1024 {
        return std::ptr::null();
    }
    let Ok(text) = std::str::from_utf8(std::slice::from_raw_parts(input, len as usize)) else {
        return std::ptr::null();
    };
    let response = call(text);
    let mut r = registry().lock().unwrap();
    r.output = CString::new(response).unwrap();
    r.output.as_ptr()
}
#[cfg(test)]
mod tests {
    use super::*;
    fn test_body(world: &mut World, kind:&str, x:f32,y:f32,z:f32, shape:Value)->u32 {
        world.call(&json!({"op":"createBody","options":{"type":kind,"position":{"x":x,"y":y,"z":z},"shape":shape}})).unwrap()["id"].as_u64().unwrap() as u32
    }
    fn move_test(world:&mut World,id:u32,desired:Value)->Value {
        let result=world.call(&json!({"op":"characterMove","body":id,"desired":desired,"dt":1.0/60.0,"stepHeight":0.35,"snapDistance":0.22,"maxSlope":0.785})).unwrap();
        let h=world.handle(id).unwrap();let p=*world.bodies[h].translation();let d=vec(&result["movement"],Vector::zeros()).unwrap();
        world.call(&json!({"op":"target","body":id,"value":{"x":p.x+d.x,"y":p.y+d.y,"z":p.z+d.z}})).unwrap();
        world.call(&json!({"op":"step","dt":1.0/60.0})).unwrap();result
    }
    #[test]
    fn native_character_floor_wall_ceiling_and_teleport() {
        let mut w=World::new(vector![0.0,-9.81,0.0]);
        test_body(&mut w,"fixed",0.0,-0.5,0.0,json!({"kind":"box","halfExtents":[10,0.5,10]}));
        test_body(&mut w,"fixed",2.0,1.0,0.0,json!({"kind":"box","halfExtents":[0.2,1,4]}));
        let c=test_body(&mut w,"kinematic",0.0,1.0,0.0,json!({"kind":"capsule","radius":0.3,"halfHeight":0.6}));
        let mut result=Value::Null;
        for _ in 0..120 {result=move_test(&mut w,c,json!({"x":0.1,"y":-0.1,"z":0}));}
        let h=w.handle(c).unwrap();let p=*w.bodies[h].translation();
        assert!(p.x>1.0 && p.x<1.52,"wall: {p:?}");assert!(p.y>0.89 && p.y<0.95,"floor: {p:?}");assert_eq!(result["grounded"],true);
        test_body(&mut w,"fixed",0.0,2.5,0.0,json!({"kind":"box","halfExtents":[1,0.1,1]}));
        w.call(&json!({"op":"translation","body":c,"value":{"x":0,"y":1,"z":0}})).unwrap();
        for _ in 0..30 {move_test(&mut w,c,json!({"x":0,"y":0.1,"z":0}));}
        assert!(w.bodies[h].translation().y < 1.52,"ceiling");
        let hit=w.call(&json!({"op":"raycast","origin":{"x":0,"y":1,"z":0},"direction":{"x":1,"y":0,"z":0},"distance":5,"ignore":c})).unwrap();
        assert_ne!(hit["collider"]["handle"],json!(c));assert!(hit["timeOfImpact"].as_f64().unwrap()>1.7);
        assert!(w.call(&json!({"op":"characterMove","body":c,"dt":0,"maxSlope":0.5})).is_err());
    }
    #[test]
    fn native_sphere_falls_and_world_is_released() {
        let created: Value = serde_json::from_str(&call(r#"{"op":"create"}"#)).unwrap();
        let world = created["value"].as_u64().unwrap();
        let send = |v: Value| -> Value { serde_json::from_str(&call(&v.to_string())).unwrap() };
        send(
            json!({"op":"createBody","world":world,"options":{"type":"fixed","position":{"x":0,"y":-0.5,"z":0},"shape":{"kind":"box","halfExtents":[5,0.5,5]}}}),
        );
        let ball = send(
            json!({"op":"createBody","world":world,"options":{"position":{"x":0,"y":3,"z":0},"shape":{"kind":"sphere","radius":0.5}}}),
        );
        let id = ball["value"]["id"].as_u64().unwrap();
        let mut state = Value::Null;
        for _ in 0..180 {
            state = send(json!({"op":"step","world":world,"dt":1.0/60.0}));
        }
        let pose = state["value"]["poses"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"].as_u64() == Some(id))
            .unwrap();
        assert!((pose["position"]["y"].as_f64().unwrap() - 0.5).abs() < 0.05);
        send(json!({"op":"dispose","world":world}));
        assert!(send(json!({"op":"stats","world":world}))["error"].is_string());
    }
}
