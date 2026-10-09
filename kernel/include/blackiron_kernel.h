// C ABI of the Blackiron kernel. Every function takes the kernel handle returned by blackiron_new.
// Buffers returned as pointers are owned by the kernel and stay valid until blackiron_free,
// except batch data, which lives until the batch is destroyed.
#ifndef BLACKIRON_KERNEL_H
#define BLACKIRON_KERNEL_H
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct BlackironKernel BlackironKernel;

uint32_t blackiron_version(void);
uint32_t blackiron_floats_per_vertex(void);
/* Fixed command size, or MESH header size (add vertex_count * 4). */
uint32_t blackiron_op_words(uint32_t op);
BlackironKernel *blackiron_new(uint32_t max_quads, uint32_t stream_words);
void blackiron_free(BlackironKernel *k);

float *blackiron_stream(BlackironKernel *k);
uint32_t blackiron_stream_words(BlackironKernel *k);
float *blackiron_scratch(BlackironKernel *k);
uint32_t blackiron_scratch_words(BlackironKernel *k);
const float *blackiron_vertices(BlackironKernel *k);
uint32_t blackiron_vertex_cap(BlackironKernel *k);
const uint32_t *blackiron_commands(BlackironKernel *k);
uint32_t blackiron_command_cap(BlackironKernel *k);
const uint32_t *blackiron_stats(BlackironKernel *k);

void blackiron_set_white(BlackironKernel *k, float u, float v);
void blackiron_run(BlackironKernel *k, uint32_t stream_len);

int32_t blackiron_batch_create(BlackironKernel *k, uint32_t capacity);
float *blackiron_batch_data(BlackironKernel *k, int32_t id);
void blackiron_batch_set_count(BlackironKernel *k, int32_t id, uint32_t count);
void blackiron_batch_destroy(BlackironKernel *k, int32_t id);

int32_t blackiron_emitter_create(BlackironKernel *k, uint32_t config_words);
void blackiron_emitter_burst(BlackironKernel *k, int32_t id, uint32_t n, float x, float y);
uint32_t blackiron_emitter_count(BlackironKernel *k, int32_t id);
void blackiron_emitter_clear(BlackironKernel *k, int32_t id);
void blackiron_emitter_destroy(BlackironKernel *k, int32_t id);

// --- Node tables: retained sprites the kernel moves, animates and draws (32 floats each) ---
int32_t blackiron_nodes_create(BlackironKernel *k, uint32_t capacity);
float *blackiron_nodes_data(BlackironKernel *k, int32_t id);
uint32_t blackiron_nodes_capacity(BlackironKernel *k, int32_t id);
int32_t blackiron_nodes_alloc(BlackironKernel *k, int32_t id);
void blackiron_nodes_free(BlackironKernel *k, int32_t id, int32_t index);
void blackiron_nodes_clear(BlackironKernel *k, int32_t id);
uint32_t blackiron_nodes_count(BlackironKernel *k, int32_t id);
uint32_t blackiron_nodes_high(BlackironKernel *k, int32_t id);
void blackiron_nodes_step(BlackironKernel *k, int32_t id, float dt);
void blackiron_nodes_configure(BlackironKernel *k, int32_t id, float gx, float gy, float damping, uint32_t bounds_mode, float bx, float by, float bw, float bh, float gz, uint32_t floor_mode);
// Frames (8 floats each: w, h, ox, oy, u0, v0, u1, v1) and physics transforms (8 floats per
// body) are read from the scratch buffer.
void blackiron_nodes_set_frames(BlackironKernel *k, int32_t id, uint32_t words);
uint32_t blackiron_nodes_apply_transforms(BlackironKernel *k, int32_t id, uint32_t words);
void blackiron_nodes_destroy(BlackironKernel *k, int32_t id);

// --- World-space batches (14 floats per instance: gx, gy, gz, w, h, ox, oy, u0, v0, u1, v1,
// tint, alpha, depth bias), projected and depth-sorted under a PROJECTION op; and the atlas
// region drawn as a blob shadow under nodes that ask for one.
int32_t blackiron_batch3_create(BlackironKernel *k, uint32_t capacity);
float *blackiron_batch3_data(BlackironKernel *k, int32_t id);
void blackiron_batch3_set_count(BlackironKernel *k, int32_t id, uint32_t count);
void blackiron_batch3_destroy(BlackironKernel *k, int32_t id);
void blackiron_set_shadow(BlackironKernel *k, float w, float h, float ox, float oy, float u0, float v0, float u1, float v1);

// --- Audio: a software synthesiser and mixer rendered on the host's audio thread ---------
typedef struct BlackironAudio BlackironAudio;

BlackironAudio *blackiron_audio_new(uint32_t sample_rate, uint32_t max_voices);
void blackiron_audio_free(BlackironAudio *a);
float *blackiron_audio_scratch(BlackironAudio *a);
uint32_t blackiron_audio_scratch_words(BlackironAudio *a);
// Script thread: queue the first `words` floats of the scratch buffer as one command.
int32_t blackiron_audio_command(BlackironAudio *a, uint32_t words);
int32_t blackiron_audio_sample_begin(BlackironAudio *a, int32_t id, uint32_t frames);
int32_t blackiron_audio_sample_write(BlackironAudio *a, int32_t id, uint32_t offset, uint32_t words);
// Streaming music: send the encoded file (bytes through the scratch buffer), open it, play it
// with CMD_STREAM. Open returns the sample rate, or 0 when the kernel has no codec for it.
int32_t blackiron_audio_stream_begin(BlackironAudio *a, int32_t id, uint32_t len);
int32_t blackiron_audio_stream_write(BlackironAudio *a, int32_t id, uint32_t bytes);
uint32_t blackiron_audio_stream_open(BlackironAudio *a, int32_t id);
void blackiron_audio_stream_close(BlackironAudio *a, int32_t id);
double blackiron_audio_time(BlackironAudio *a);
float blackiron_audio_peak(BlackironAudio *a);
uint32_t blackiron_audio_active(BlackironAudio *a);
const float *blackiron_audio_out(BlackironAudio *a);
// Audio thread: render `frames` frames of interleaved stereo (2 floats per frame) for the
// block at absolute frame `position`.
void blackiron_audio_render(BlackironAudio *a, double position, uint32_t frames);
/* Writes frames * 2 interleaved stereo floats; position is measured in frames. */
void blackiron_audio_render_into(BlackironAudio *a, double position, float *out, uint32_t frames);

// --- Physics: rapier behind one call; arguments and results travel through the scratch ---
typedef struct BlackironPhysics BlackironPhysics;

BlackironPhysics *blackiron_physics_new(float pixels_per_meter);
void blackiron_physics_free(BlackironPhysics *p);
float *blackiron_physics_scratch(BlackironPhysics *p);
uint32_t blackiron_physics_scratch_words(BlackironPhysics *p);
int32_t blackiron_physics_call(BlackironPhysics *p, uint32_t op, uint32_t words);
const float *blackiron_physics_transforms(BlackironPhysics *p);
uint32_t blackiron_physics_transform_count(BlackironPhysics *p);
const float *blackiron_physics_events(BlackironPhysics *p);
uint32_t blackiron_physics_event_count(BlackironPhysics *p);

// --- Rendering: the wgpu renderer on a CAMetalLayer (feature "render") ---------------------
typedef struct BlackironRenderer BlackironRenderer;

BlackironRenderer *blackiron_render_new_metal_layer(void *layer, uint32_t width, uint32_t height, uint32_t max_quads);
void blackiron_render_free(BlackironRenderer *r);
void blackiron_render_resize(BlackironRenderer *r, uint32_t width, uint32_t height);
void blackiron_render_upload_texture(BlackironRenderer *r, uint32_t slot, uint32_t width, uint32_t height, const uint8_t *rgba);
// Draw the kernel's frame (10 floats per vertex, the command words and the post array);
// with `capture` the presented image is read back for blackiron_render_capture_*.
const char *blackiron_physics3d_json(const uint8_t *input, uint32_t len);
uint64_t blackiron_render_mesh_resource(const BlackironRenderer *r, uint32_t index);
int32_t blackiron_render_mesh(BlackironRenderer *r, const uint8_t *bytes, uint32_t len);
int32_t blackiron_render_frame(BlackironRenderer *r, const float *vertices, uint32_t vertex_count, const uint32_t *commands, uint32_t command_count, const float *post, uint32_t post_len, int32_t capture);
uint32_t blackiron_render_capture_size(BlackironRenderer *r, uint32_t *width, uint32_t *height);
uint32_t blackiron_render_capture_read(BlackironRenderer *r, uint8_t *out, uint32_t cap);

#ifdef __cplusplus
}
#endif
#endif
