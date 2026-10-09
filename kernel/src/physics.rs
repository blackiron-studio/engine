//! 2D physics through rapier, behind one call-style entry point so every host binds a
//! single function: arguments go in the scratch buffer, results come back in it, and the
//! transforms and collision events of a step land in two read-only buffers. Games work
//! in pixels; `pixels_per_meter` converts to rapier's units inside.

use std::sync::Mutex;

use rapier2d::control::{CharacterAutostep, CharacterLength, KinematicCharacterController};
use rapier2d::parry::query::ShapeCastOptions;
use rapier2d::prelude::*;

pub const SCRATCH_WORDS: usize = 4096;
pub const TRANSFORM_STRIDE: usize = 8;
pub const EVENT_STRIDE: usize = 4;

pub const OP_SET_GRAVITY: u32 = 1;
pub const OP_BODY_CREATE: u32 = 2;
pub const OP_BODY_DESTROY: u32 = 3;
pub const OP_BODY_SET_POSITION: u32 = 4;
pub const OP_BODY_SET_VELOCITY: u32 = 5;
pub const OP_BODY_APPLY_IMPULSE: u32 = 6;
pub const OP_BODY_APPLY_FORCE: u32 = 7;
pub const OP_BODY_KINEMATIC_TARGET: u32 = 8;
pub const OP_BODY_GET: u32 = 9;
pub const OP_BODY_SET: u32 = 10;
pub const OP_COLLIDER_CREATE: u32 = 11;
pub const OP_COLLIDER_DESTROY: u32 = 12;
pub const OP_COLLIDER_SET: u32 = 13;
pub const OP_JOINT_CREATE: u32 = 14;
pub const OP_JOINT_DESTROY: u32 = 15;
pub const OP_STEP: u32 = 16;
pub const OP_RAYCAST: u32 = 17;
pub const OP_POINT_QUERY: u32 = 18;
pub const OP_AABB_QUERY: u32 = 19;
pub const OP_CHARACTER_MOVE: u32 = 20;
pub const OP_BODY_COUNT: u32 = 21;
/// Sweep a shape: [type, s0, s1, x, y, dx, dy, max, mask] -> [collider, x, y, nx, ny, distance, body].
pub const OP_SHAPE_CAST: u32 = 22;

#[derive(Default)]
struct Collector(Mutex<Vec<[f32; EVENT_STRIDE]>>);

impl EventHandler for Collector {
    fn handle_collision_event(&self, _bodies: &RigidBodySet, _colliders: &ColliderSet, event: CollisionEvent, _pair: Option<&ContactPair>) {
        let (kind, a, b, sensor) = match event {
            CollisionEvent::Started(a, b, flags) => (1.0, a, b, flags.contains(CollisionEventFlags::SENSOR)),
            CollisionEvent::Stopped(a, b, flags) => (2.0, a, b, flags.contains(CollisionEventFlags::SENSOR)),
        };
        if let Ok(mut v) = self.0.lock() {
            v.push([kind, a.into_raw_parts().0 as f32, b.into_raw_parts().0 as f32, if sensor { 1.0 } else { 0.0 }]);
        }
    }

    fn handle_contact_force_event(&self, _dt: f32, _bodies: &RigidBodySet, _colliders: &ColliderSet, _pair: &ContactPair, _total: f32) {}
}

pub struct Physics {
    ppm: f32,
    gravity: Vector<f32>,
    params: IntegrationParameters,
    pipeline: PhysicsPipeline,
    islands: IslandManager,
    broad: DefaultBroadPhase,
    narrow: NarrowPhase,
    bodies: RigidBodySet,
    colliders: ColliderSet,
    impulse_joints: ImpulseJointSet,
    multibody_joints: MultibodyJointSet,
    ccd: CCDSolver,
    query: QueryPipeline,
    collector: Collector,
    body_ids: Vec<Option<RigidBodyHandle>>,
    collider_ids: Vec<Option<ColliderHandle>>,
    joint_ids: Vec<Option<ImpulseJointHandle>>,
    scratch: Vec<f32>,
    transforms: Vec<f32>,
    events: Vec<f32>,
}

fn slot<T: Copy>(table: &mut Vec<Option<T>>, value: T) -> i32 {
    if let Some(i) = table.iter().position(|s| s.is_none()) {
        table[i] = Some(value);
        i as i32
    } else {
        table.push(Some(value));
        (table.len() - 1) as i32
    }
}

impl Physics {
    pub fn new(pixels_per_meter: f32) -> Physics {
        let ppm = if pixels_per_meter > 0.0 { pixels_per_meter } else { 100.0 };
        Physics {
            ppm,
            gravity: vector![0.0, 980.0 / ppm],
            params: IntegrationParameters::default(),
            pipeline: PhysicsPipeline::new(),
            islands: IslandManager::new(),
            broad: DefaultBroadPhase::new(),
            narrow: NarrowPhase::new(),
            bodies: RigidBodySet::new(),
            colliders: ColliderSet::new(),
            impulse_joints: ImpulseJointSet::new(),
            multibody_joints: MultibodyJointSet::new(),
            ccd: CCDSolver::new(),
            query: QueryPipeline::new(),
            collector: Collector::default(),
            body_ids: Vec::new(),
            collider_ids: Vec::new(),
            joint_ids: Vec::new(),
            scratch: vec![0.0; SCRATCH_WORDS],
            transforms: Vec::new(),
            events: Vec::new(),
        }
    }

    pub fn scratch_mut(&mut self) -> &mut [f32] {
        &mut self.scratch
    }

    pub fn scratch(&self) -> &[f32] {
        &self.scratch
    }

    pub fn transforms(&self) -> &[f32] {
        &self.transforms
    }

    pub fn events(&self) -> &[f32] {
        &self.events
    }

    fn body(&self, id: f32) -> Option<RigidBodyHandle> {
        self.body_ids.get(id as usize).copied().flatten()
    }

    fn collider(&self, id: f32) -> Option<ColliderHandle> {
        self.collider_ids.get(id as usize).copied().flatten()
    }

    fn collider_id(&self, h: ColliderHandle) -> f32 {
        self.collider_ids.iter().position(|c| *c == Some(h)).map(|i| i as f32).unwrap_or(-1.0)
    }

    fn body_id(&self, h: RigidBodyHandle) -> f32 {
        self.body_ids.iter().position(|c| *c == Some(h)).map(|i| i as f32).unwrap_or(-1.0)
    }

    /// Run one operation with `words` arguments in the scratch buffer. Results are written
    /// back to the scratch buffer; the return value is an id, a count or a flag.
    pub fn call(&mut self, op: u32, words: usize) -> i32 {
        let n = words.min(self.scratch.len());
        let a: Vec<f32> = self.scratch[..n].to_vec();
        let g = |k: usize| -> f32 { a.get(k).copied().unwrap_or(0.0) };
        let ppm = self.ppm;
        match op {
            OP_SET_GRAVITY => {
                self.gravity = vector![g(0) / ppm, g(1) / ppm];
                1
            }
            OP_BODY_CREATE => {
                let kind = g(0) as u32;
                let flags = g(4) as u32;
                let mut b = match kind {
                    0 => RigidBodyBuilder::fixed(),
                    2 => RigidBodyBuilder::kinematic_position_based(),
                    3 => RigidBodyBuilder::kinematic_velocity_based(),
                    _ => RigidBodyBuilder::dynamic(),
                }
                .translation(vector![g(1) / ppm, g(2) / ppm])
                .rotation(g(3))
                .linear_damping(g(5))
                .angular_damping(g(6))
                .gravity_scale(if n > 7 { g(7) } else { 1.0 })
                .ccd_enabled(flags & 2 != 0)
                .can_sleep(flags & 4 == 0);
                if flags & 1 != 0 {
                    b = b.lock_rotations();
                }
                let h = self.bodies.insert(b.build());
                let id = slot(&mut self.body_ids, h);
                self.bodies[h].user_data = id as u128;
                id
            }
            OP_BODY_DESTROY => {
                if let Some(h) = self.body(g(0)) {
                    self.bodies.remove(h, &mut self.islands, &mut self.colliders, &mut self.impulse_joints, &mut self.multibody_joints, true);
                    self.body_ids[g(0) as usize] = None;
                    for c in self.collider_ids.iter_mut() {
                        if let Some(ch) = c {
                            if self.colliders.get(*ch).is_none() {
                                *c = None;
                            }
                        }
                    }
                    self.joint_ids.iter_mut().for_each(|j| {
                        if let Some(jh) = j {
                            if self.impulse_joints.get(*jh).is_none() {
                                *j = None;
                            }
                        }
                    });
                }
                1
            }
            OP_BODY_SET_POSITION => {
                if let Some(h) = self.body(g(0)) {
                    let b = &mut self.bodies[h];
                    b.set_position(Isometry::new(vector![g(1) / ppm, g(2) / ppm], g(3)), true);
                }
                1
            }
            OP_BODY_SET_VELOCITY => {
                if let Some(h) = self.body(g(0)) {
                    let b = &mut self.bodies[h];
                    b.set_linvel(vector![g(1) / ppm, g(2) / ppm], true);
                    b.set_angvel(g(3), true);
                }
                1
            }
            OP_BODY_APPLY_IMPULSE => {
                if let Some(h) = self.body(g(0)) {
                    let b = &mut self.bodies[h];
                    let mass = b.mass().max(1e-6);
                    // Impulses arrive in pixel units of momentum per unit mass, so a game can
                    // say "kick it 300 px/s" without knowing the body's mass.
                    b.apply_impulse(vector![g(1) / ppm * mass, g(2) / ppm * mass], true);
                    if n > 3 {
                        b.apply_torque_impulse(g(3) * mass, true);
                    }
                }
                1
            }
            OP_BODY_APPLY_FORCE => {
                if let Some(h) = self.body(g(0)) {
                    let b = &mut self.bodies[h];
                    let mass = b.mass().max(1e-6);
                    b.add_force(vector![g(1) / ppm * mass, g(2) / ppm * mass], true);
                }
                1
            }
            OP_BODY_KINEMATIC_TARGET => {
                if let Some(h) = self.body(g(0)) {
                    let b = &mut self.bodies[h];
                    b.set_next_kinematic_position(Isometry::new(vector![g(1) / ppm, g(2) / ppm], g(3)));
                }
                1
            }
            OP_BODY_GET => {
                let Some(h) = self.body(g(0)) else { return 0 };
                let b = &self.bodies[h];
                let p = b.translation();
                let v = b.linvel();
                let out = [p.x * ppm, p.y * ppm, b.rotation().angle(), v.x * ppm, v.y * ppm, b.angvel(), if b.is_sleeping() { 1.0 } else { 0.0 }];
                self.scratch[..out.len()].copy_from_slice(&out);
                1
            }
            OP_BODY_SET => {
                if let Some(h) = self.body(g(0)) {
                    let b = &mut self.bodies[h];
                    match g(1) as u32 {
                        0 => b.wake_up(true),
                        1 => b.sleep(),
                        2 => b.set_gravity_scale(g(2), true),
                        3 => b.set_linear_damping(g(2)),
                        4 => b.set_angular_damping(g(2)),
                        5 => b.lock_rotations(g(2) != 0.0, true),
                        6 => b.set_body_type(
                            match g(2) as u32 {
                                0 => RigidBodyType::Fixed,
                                2 => RigidBodyType::KinematicPositionBased,
                                3 => RigidBodyType::KinematicVelocityBased,
                                _ => RigidBodyType::Dynamic,
                            },
                            true,
                        ),
                        7 => b.set_additional_mass(g(2), true),
                        _ => {}
                    }
                }
                1
            }
            OP_COLLIDER_CREATE => {
                let Some(bh) = self.body(g(0)) else { return -1 };
                let shape = g(1) as u32;
                let s0 = g(2) / ppm;
                let s1 = g(3) / ppm;
                let mut c = match shape {
                    1 => ColliderBuilder::ball(s0.max(1e-4)),
                    2 => ColliderBuilder::capsule_y((s0 / 2.0).max(1e-4), s1.max(1e-4)),
                    3 => {
                        let count = g(3) as usize;
                        let pts: Vec<Point<f32>> = (0..count).map(|i| point![g(14 + i * 2) / ppm, g(15 + i * 2) / ppm]).collect();
                        match ColliderBuilder::convex_hull(&pts) {
                            Some(b) => b,
                            None => ColliderBuilder::ball(0.01),
                        }
                    }
                    _ => ColliderBuilder::cuboid((s0 / 2.0).max(1e-4), (s1 / 2.0).max(1e-4)),
                };
                c = c
                    .translation(vector![g(4) / ppm, g(5) / ppm])
                    .rotation(g(6))
                    .density(if g(7) > 0.0 { g(7) } else { 1.0 })
                    .friction(g(8))
                    .restitution(g(9))
                    .sensor(g(10) != 0.0)
                    .collision_groups(InteractionGroups::new(Group::from_bits_truncate(g(11) as u32), Group::from_bits_truncate(g(12) as u32)))
                    .active_events(ActiveEvents::COLLISION_EVENTS);
                let h = self.colliders.insert_with_parent(c.build(), bh, &mut self.bodies);
                let id = slot(&mut self.collider_ids, h);
                self.colliders[h].user_data = id as u128;
                id
            }
            OP_COLLIDER_DESTROY => {
                if let Some(h) = self.collider(g(0)) {
                    self.colliders.remove(h, &mut self.islands, &mut self.bodies, true);
                    self.collider_ids[g(0) as usize] = None;
                }
                1
            }
            OP_COLLIDER_SET => {
                if let Some(h) = self.collider(g(0)) {
                    let c = &mut self.colliders[h];
                    match g(1) as u32 {
                        0 => c.set_sensor(g(2) != 0.0),
                        1 => c.set_collision_groups(InteractionGroups::new(Group::from_bits_truncate(g(2) as u32), Group::from_bits_truncate(g(3) as u32))),
                        2 => c.set_friction(g(2)),
                        3 => c.set_restitution(g(2)),
                        4 => c.set_density(g(2)),
                        // One-way: a character passes through from below and when moving up.
                        5 => c.user_data = if g(2) != 0.0 { c.user_data | 1 } else { c.user_data & !1 },
                        _ => {}
                    }
                }
                1
            }
            OP_JOINT_CREATE => {
                let (Some(a1), Some(b1)) = (self.body(g(1)), self.body(g(2))) else { return -1 };
                let anchor1 = point![g(3) / ppm, g(4) / ppm];
                let anchor2 = point![g(5) / ppm, g(6) / ppm];
                let joint: GenericJoint = match g(0) as u32 {
                    1 => {
                        let mut j = RevoluteJointBuilder::new().local_anchor1(anchor1).local_anchor2(anchor2);
                        if g(9) != g(10) {
                            j = j.limits([g(9), g(10)]);
                        }
                        j.build().into()
                    }
                    2 => {
                        let axis = UnitVector::new_normalize(vector![g(7), g(8)]);
                        let mut j = PrismaticJointBuilder::new(axis).local_anchor1(anchor1).local_anchor2(anchor2);
                        if g(9) != g(10) {
                            j = j.limits([g(9) / ppm, g(10) / ppm]);
                        }
                        j.build().into()
                    }
                    3 => SpringJointBuilder::new(g(7) / ppm, g(8), g(9)).local_anchor1(anchor1).local_anchor2(anchor2).build().into(),
                    4 => RopeJointBuilder::new(g(7) / ppm).local_anchor1(anchor1).local_anchor2(anchor2).build().into(),
                    _ => FixedJointBuilder::new().local_anchor1(anchor1).local_anchor2(anchor2).build().into(),
                };
                let h = self.impulse_joints.insert(a1, b1, joint, true);
                slot(&mut self.joint_ids, h)
            }
            OP_JOINT_DESTROY => {
                if let Some(h) = self.joint_ids.get(g(0) as usize).copied().flatten() {
                    self.impulse_joints.remove(h, true);
                    self.joint_ids[g(0) as usize] = None;
                }
                1
            }
            OP_STEP => {
                self.params.dt = g(0).max(1e-4);
                if let Ok(mut v) = self.collector.0.lock() {
                    v.clear();
                }
                self.pipeline.step(
                    &self.gravity,
                    &self.params,
                    &mut self.islands,
                    &mut self.broad,
                    &mut self.narrow,
                    &mut self.bodies,
                    &mut self.colliders,
                    &mut self.impulse_joints,
                    &mut self.multibody_joints,
                    &mut self.ccd,
                    Some(&mut self.query),
                    &(),
                    &self.collector,
                );
                self.transforms.clear();
                for (h, b) in self.bodies.iter() {
                    if b.is_fixed() {
                        continue;
                    }
                    let p = b.translation();
                    let v = b.linvel();
                    self.transforms.extend_from_slice(&[b.user_data as f32, p.x * ppm, p.y * ppm, b.rotation().angle(), v.x * ppm, v.y * ppm, b.angvel(), if b.is_sleeping() { 1.0 } else { 0.0 }]);
                    let _ = h;
                }
                for (_, b) in self.bodies.iter_mut() {
                    b.reset_forces(false);
                }
                self.events.clear();
                if let Ok(v) = self.collector.0.lock() {
                    for e in v.iter() {
                        // Translate collider handle indices to our ids.
                        let a = self.collider_ids.iter().position(|c| c.map(|h| h.into_raw_parts().0 as f32 == e[1]).unwrap_or(false)).map(|i| i as f32).unwrap_or(-1.0);
                        let b = self.collider_ids.iter().position(|c| c.map(|h| h.into_raw_parts().0 as f32 == e[2]).unwrap_or(false)).map(|i| i as f32).unwrap_or(-1.0);
                        self.events.extend_from_slice(&[e[0], a, b, e[3]]);
                    }
                }
                (self.events.len() / EVENT_STRIDE) as i32
            }
            OP_RAYCAST => {
                self.query.update(&self.colliders);
                let origin = point![g(0) / ppm, g(1) / ppm];
                let dir = vector![g(2), g(3)];
                if dir.norm() <= 0.0 {
                    return 0;
                }
                let dir = dir.normalize();
                let max = g(4) / ppm;
                let mask = if n > 5 { g(5) as u32 } else { u32::MAX };
                let solid = n <= 6 || g(6) != 0.0;
                let filter = QueryFilter::default().groups(InteractionGroups::new(Group::ALL, Group::from_bits_truncate(mask)));
                match self.query.cast_ray_and_get_normal(&self.bodies, &self.colliders, &Ray::new(origin, dir), max, solid, filter) {
                    Some((h, hit)) => {
                        let p = origin + dir * hit.time_of_impact;
                        let body = self.colliders[h].parent().map(|b| self.body_id(b)).unwrap_or(-1.0);
                        let out = [self.collider_id(h), p.x * ppm, p.y * ppm, hit.normal.x, hit.normal.y, hit.time_of_impact * ppm, body];
                        self.scratch[..out.len()].copy_from_slice(&out);
                        1
                    }
                    None => 0,
                }
            }
            OP_POINT_QUERY => {
                self.query.update(&self.colliders);
                let p = point![g(0) / ppm, g(1) / ppm];
                let mask = if n > 2 { g(2) as u32 } else { u32::MAX };
                let max = if n > 3 { (g(3) as usize).max(1) } else { 32 };
                let filter = QueryFilter::default().groups(InteractionGroups::new(Group::ALL, Group::from_bits_truncate(mask)));
                let mut found: Vec<f32> = Vec::new();
                self.query.intersections_with_point(&self.bodies, &self.colliders, &p, filter, |h| {
                    found.push(self.collider_id(h));
                    found.len() < max
                });
                let count = found.len().min(self.scratch.len());
                self.scratch[..count].copy_from_slice(&found[..count]);
                count as i32
            }
            OP_AABB_QUERY => {
                self.query.update(&self.colliders);
                let aabb = Aabb::new(point![g(0) / ppm, g(1) / ppm], point![(g(0) + g(2)) / ppm, (g(1) + g(3)) / ppm]);
                let mask = if n > 4 { g(4) as u32 } else { u32::MAX };
                let max = if n > 5 { (g(5) as usize).max(1) } else { 32 };
                let mut found: Vec<f32> = Vec::new();
                self.query.colliders_with_aabb_intersecting_aabb(&aabb, |h| {
                    if let Some(c) = self.colliders.get(*h) {
                        if c.collision_groups().memberships.bits() & mask != 0 {
                            found.push(self.collider_id(*h));
                        }
                    }
                    found.len() < max
                });
                let count = found.len().min(self.scratch.len());
                self.scratch[..count].copy_from_slice(&found[..count]);
                count as i32
            }
            OP_CHARACTER_MOVE => {
                let (Some(bh), Some(ch)) = (self.body(g(0)), self.collider(g(1))) else { return 0 };
                self.query.update(&self.colliders);
                let dt = g(4).max(1e-4);
                let mut controller = KinematicCharacterController { up: UnitVector::new_normalize(vector![0.0, -1.0]), offset: CharacterLength::Absolute(0.005), slide: true, ..Default::default() };
                controller.snap_to_ground = if g(5) > 0.0 { Some(CharacterLength::Absolute(g(5) / ppm)) } else { None };
                if g(6) > 0.0 {
                    controller.max_slope_climb_angle = g(6).to_radians();
                    controller.min_slope_slide_angle = (g(6) + 5.0).to_radians();
                }
                controller.autostep = if g(7) > 0.0 { Some(CharacterAutostep { max_height: CharacterLength::Absolute(g(7) / ppm), min_width: CharacterLength::Absolute(0.1), include_dynamic_bodies: false }) } else { None };
                let collider = &self.colliders[ch];
                let shape = collider.shape();
                // From the body's current position, not the collider's, which only follows after a step.
                let body_pos = *self.bodies[bh].position();
                let pos = match collider.position_wrt_parent() {
                    Some(rel) => body_pos * rel,
                    None => *collider.position(),
                };
                let desired = vector![g(2) / ppm, g(3) / ppm];
                let bottom = shape.compute_aabb(&pos).maxs.y;
                let moving_up = desired.y < 0.0;
                let one_way = |_h: ColliderHandle, c: &Collider| -> bool {
                    if c.user_data & 1 == 0 {
                        return true;
                    }
                    // A one-way platform only stops a character coming down onto its top.
                    !moving_up && bottom <= c.compute_aabb().mins.y + 0.05
                };
                let filter = QueryFilter::default().exclude_rigid_body(bh).exclude_sensors().predicate(&one_way);
                let moved = controller.move_shape(dt, &self.bodies, &self.colliders, &self.query, shape, &pos, desired, filter, |_| {});
                let body = &mut self.bodies[bh];
                let new_pos = body.translation() + moved.translation;
                body.set_next_kinematic_translation(new_pos);
                body.set_translation(new_pos, true);
                let out = [new_pos.x * ppm, new_pos.y * ppm, if moved.grounded { 1.0 } else { 0.0 }, if moved.is_sliding_down_slope { 1.0 } else { 0.0 }, moved.translation.x * ppm, moved.translation.y * ppm];
                self.scratch[..out.len()].copy_from_slice(&out);
                1
            }
            OP_SHAPE_CAST => {
                self.query.update(&self.colliders);
                let (s0, s1) = (g(1) / ppm, g(2) / ppm);
                let shape: SharedShape = match g(0) as u32 {
                    1 => SharedShape::ball(s0.max(1e-4)),
                    2 => SharedShape::capsule_y((s0 / 2.0).max(1e-4), s1.max(1e-4)),
                    _ => SharedShape::cuboid((s0 / 2.0).max(1e-4), (s1 / 2.0).max(1e-4)),
                };
                let origin = vector![g(3) / ppm, g(4) / ppm];
                let dir = vector![g(5), g(6)];
                if dir.norm() <= 0.0 {
                    return 0;
                }
                let dir = dir.normalize();
                let max = g(7) / ppm;
                let mask = if n > 8 { g(8) as u32 } else { u32::MAX };
                let filter = QueryFilter::default().groups(InteractionGroups::new(Group::ALL, Group::from_bits_truncate(mask)));
                let options = ShapeCastOptions { max_time_of_impact: max, stop_at_penetration: true, ..Default::default() };
                match self.query.cast_shape(&self.bodies, &self.colliders, &Isometry::translation(origin.x, origin.y), &dir, &*shape, options, filter) {
                    Some((h, hit)) => {
                        let p = origin + dir * hit.time_of_impact;
                        let body = self.colliders[h].parent().map(|b| self.body_id(b)).unwrap_or(-1.0);
                        let out = [self.collider_id(h), p.x * ppm, p.y * ppm, hit.normal1.x, hit.normal1.y, hit.time_of_impact * ppm, body];
                        self.scratch[..out.len()].copy_from_slice(&out);
                        1
                    }
                    None => 0,
                }
            }
            OP_BODY_COUNT => self.bodies.len() as i32,
            _ => -1,
        }
    }
}

// --- C ABI ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn kiln_physics_new(pixels_per_meter: f32) -> *mut Physics {
    Box::into_raw(Box::new(Physics::new(pixels_per_meter)))
}

/// # Safety
/// `p` must come from `kiln_physics_new` and not be used afterwards.
#[no_mangle]
pub unsafe extern "C" fn kiln_physics_free(p: *mut Physics) {
    if !p.is_null() {
        drop(Box::from_raw(p));
    }
}

macro_rules! with_physics {
    ($p:expr, $body:expr, $default:expr) => {{
        if $p.is_null() {
            $default
        } else {
            let p: &mut Physics = unsafe { &mut *$p };
            #[allow(clippy::redundant_closure_call)]
            ($body)(p)
        }
    }};
}

#[no_mangle]
pub extern "C" fn kiln_physics_scratch(p: *mut Physics) -> *mut f32 {
    with_physics!(p, |p: &mut Physics| p.scratch.as_mut_ptr(), std::ptr::null_mut())
}

#[no_mangle]
pub extern "C" fn kiln_physics_scratch_words(p: *mut Physics) -> u32 {
    with_physics!(p, |p: &mut Physics| p.scratch.len() as u32, 0)
}

#[no_mangle]
pub extern "C" fn kiln_physics_call(p: *mut Physics, op: u32, words: u32) -> i32 {
    with_physics!(p, |p: &mut Physics| p.call(op, words as usize), -1)
}

#[no_mangle]
pub extern "C" fn kiln_physics_transforms(p: *mut Physics) -> *const f32 {
    with_physics!(p, |p: &mut Physics| p.transforms.as_ptr(), std::ptr::null())
}

#[no_mangle]
pub extern "C" fn kiln_physics_transform_count(p: *mut Physics) -> u32 {
    with_physics!(p, |p: &mut Physics| (p.transforms.len() / TRANSFORM_STRIDE) as u32, 0)
}

#[no_mangle]
pub extern "C" fn kiln_physics_events(p: *mut Physics) -> *const f32 {
    with_physics!(p, |p: &mut Physics| p.events.as_ptr(), std::ptr::null())
}

#[no_mangle]
pub extern "C" fn kiln_physics_event_count(p: *mut Physics) -> u32 {
    with_physics!(p, |p: &mut Physics| (p.events.len() / EVENT_STRIDE) as u32, 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(p: &mut Physics, op: u32, args: &[f32]) -> i32 {
        p.scratch_mut()[..args.len()].copy_from_slice(args);
        p.call(op, args.len())
    }

    #[test]
    fn a_box_falls_onto_the_ground_and_reports_the_contact() {
        let mut p = Physics::new(100.0);
        let ground = call(&mut p, OP_BODY_CREATE, &[0.0, 0.0, 400.0, 0.0, 0.0, 0.0, 0.0, 1.0]);
        let gc = call(&mut p, OP_COLLIDER_CREATE, &[ground as f32, 0.0, 2000.0, 40.0, 0.0, 0.0, 0.0, 1.0, 0.5, 0.0, 0.0, 1.0, u32::MAX as f32]);
        let crate_ = call(&mut p, OP_BODY_CREATE, &[1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0]);
        let cc = call(&mut p, OP_COLLIDER_CREATE, &[crate_ as f32, 0.0, 32.0, 32.0, 0.0, 0.0, 0.0, 1.0, 0.5, 0.0, 0.0, 1.0, u32::MAX as f32]);
        assert!(ground >= 0 && gc >= 0 && crate_ >= 0 && cc >= 0);
        let mut started = false;
        for _ in 0..240 {
            let events = call(&mut p, OP_STEP, &[1.0 / 60.0]);
            if events > 0 && p.events()[0] == 1.0 {
                started = true;
            }
        }
        assert!(started, "contact event");
        assert_eq!(call(&mut p, OP_BODY_GET, &[crate_ as f32]), 1);
        let y = p.scratch()[1];
        // Resting on the ground: 400 - 20 (half ground) - 16 (half crate).
        assert!((y - 364.0).abs() < 2.0, "y = {y}");
        assert_eq!(p.transforms().len() / TRANSFORM_STRIDE, 1);
        // A ray from above hits the crate first.
        assert_eq!(call(&mut p, OP_RAYCAST, &[0.0, 0.0, 0.0, 1.0, 1000.0]), 1);
        assert_eq!(p.scratch()[0], cc as f32);
        assert!((p.scratch()[2] - 348.0).abs() < 2.0);
    }

    #[test]
    fn a_character_slides_along_the_floor() {
        let mut p = Physics::new(100.0);
        let ground = call(&mut p, OP_BODY_CREATE, &[0.0, 0.0, 100.0, 0.0, 0.0, 0.0, 0.0, 1.0]);
        call(&mut p, OP_COLLIDER_CREATE, &[ground as f32, 0.0, 2000.0, 20.0, 0.0, 0.0, 0.0, 1.0, 0.5, 0.0, 0.0, 1.0, u32::MAX as f32]);
        let hero = call(&mut p, OP_BODY_CREATE, &[2.0, 0.0, 60.0, 0.0, 0.0, 0.0, 0.0, 1.0]);
        let hc = call(&mut p, OP_COLLIDER_CREATE, &[hero as f32, 2.0, 40.0, 10.0, 0.0, 0.0, 0.0, 1.0, 0.5, 0.0, 0.0, 1.0, u32::MAX as f32]);
        let mut grounded = false;
        for _ in 0..60 {
            call(&mut p, OP_CHARACTER_MOVE, &[hero as f32, hc as f32, 2.0, 5.0, 1.0 / 60.0, 4.0, 45.0, 0.0]);
            grounded = p.scratch()[2] == 1.0;
            call(&mut p, OP_STEP, &[1.0 / 60.0]);
        }
        assert!(grounded);
        call(&mut p, OP_BODY_GET, &[hero as f32]);
        let (x, y) = (p.scratch()[0], p.scratch()[1]);
        assert!(x > 100.0, "x = {x}");
        assert!(y < 100.0 && y > 50.0, "y = {y}");
    }
}
