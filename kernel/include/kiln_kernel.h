// C ABI of the Kiln kernel. Every function takes the kernel handle returned by kiln_new.
// Buffers returned as pointers are owned by the kernel and stay valid until kiln_free,
// except batch data, which lives until the batch is destroyed.
#ifndef KILN_KERNEL_H
#define KILN_KERNEL_H
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct KilnKernel KilnKernel;

uint32_t kiln_version(void);
uint32_t kiln_floats_per_vertex(void);
/* Fixed command size, or MESH header size (add vertex_count * 4). */
uint32_t kiln_op_words(uint32_t op);
KilnKernel *kiln_new(uint32_t max_quads, uint32_t stream_words);
void kiln_free(KilnKernel *k);

float *kiln_stream(KilnKernel *k);
uint32_t kiln_stream_words(KilnKernel *k);
float *kiln_scratch(KilnKernel *k);
uint32_t kiln_scratch_words(KilnKernel *k);
const float *kiln_vertices(KilnKernel *k);
uint32_t kiln_vertex_cap(KilnKernel *k);
const uint32_t *kiln_commands(KilnKernel *k);
uint32_t kiln_command_cap(KilnKernel *k);
const uint32_t *kiln_stats(KilnKernel *k);

void kiln_set_white(KilnKernel *k, float u, float v);
void kiln_run(KilnKernel *k, uint32_t stream_len);

int32_t kiln_batch_create(KilnKernel *k, uint32_t capacity);
float *kiln_batch_data(KilnKernel *k, int32_t id);
void kiln_batch_set_count(KilnKernel *k, int32_t id, uint32_t count);
void kiln_batch_destroy(KilnKernel *k, int32_t id);

int32_t kiln_emitter_create(KilnKernel *k, uint32_t config_words);
void kiln_emitter_burst(KilnKernel *k, int32_t id, uint32_t n, float x, float y);
uint32_t kiln_emitter_count(KilnKernel *k, int32_t id);
void kiln_emitter_clear(KilnKernel *k, int32_t id);
void kiln_emitter_destroy(KilnKernel *k, int32_t id);

// --- Node tables: retained sprites the kernel moves, animates and draws (32 floats each) ---
int32_t kiln_nodes_create(KilnKernel *k, uint32_t capacity);
float *kiln_nodes_data(KilnKernel *k, int32_t id);
uint32_t kiln_nodes_capacity(KilnKernel *k, int32_t id);
int32_t kiln_nodes_alloc(KilnKernel *k, int32_t id);
void kiln_nodes_free(KilnKernel *k, int32_t id, int32_t index);
void kiln_nodes_clear(KilnKernel *k, int32_t id);
uint32_t kiln_nodes_count(KilnKernel *k, int32_t id);
uint32_t kiln_nodes_high(KilnKernel *k, int32_t id);
void kiln_nodes_step(KilnKernel *k, int32_t id, float dt);
void kiln_nodes_configure(KilnKernel *k, int32_t id, float gx, float gy, float damping, uint32_t bounds_mode, float bx, float by, float bw, float bh, float gz, uint32_t floor_mode);
// Frames (8 floats each: w, h, ox, oy, u0, v0, u1, v1) and physics transforms (8 floats per
// body) are read from the scratch buffer.
void kiln_nodes_set_frames(KilnKernel *k, int32_t id, uint32_t words);
uint32_t kiln_nodes_apply_transforms(KilnKernel *k, int32_t id, uint32_t words);
void kiln_nodes_destroy(KilnKernel *k, int32_t id);

// --- World-space batches (14 floats per instance: gx, gy, gz, w, h, ox, oy, u0, v0, u1, v1,
// tint, alpha, depth bias), projected and depth-sorted under a PROJECTION op; and the atlas
// region drawn as a blob shadow under nodes that ask for one.
int32_t kiln_batch3_create(KilnKernel *k, uint32_t capacity);
float *kiln_batch3_data(KilnKernel *k, int32_t id);
void kiln_batch3_set_count(KilnKernel *k, int32_t id, uint32_t count);
void kiln_batch3_destroy(KilnKernel *k, int32_t id);
void kiln_set_shadow(KilnKernel *k, float w, float h, float ox, float oy, float u0, float v0, float u1, float v1);

// --- Audio: a software synthesiser and mixer rendered on the host's audio thread ---------
typedef struct KilnAudio KilnAudio;

KilnAudio *kiln_audio_new(uint32_t sample_rate, uint32_t max_voices);
void kiln_audio_free(KilnAudio *a);
float *kiln_audio_scratch(KilnAudio *a);
uint32_t kiln_audio_scratch_words(KilnAudio *a);
// Script thread: queue the first `words` floats of the scratch buffer as one command.
int32_t kiln_audio_command(KilnAudio *a, uint32_t words);
int32_t kiln_audio_sample_begin(KilnAudio *a, int32_t id, uint32_t frames);
int32_t kiln_audio_sample_write(KilnAudio *a, int32_t id, uint32_t offset, uint32_t words);
// Streaming music: send the encoded file (bytes through the scratch buffer), open it, play it
// with CMD_STREAM. Open returns the sample rate, or 0 when the kernel has no codec for it.
int32_t kiln_audio_stream_begin(KilnAudio *a, int32_t id, uint32_t len);
int32_t kiln_audio_stream_write(KilnAudio *a, int32_t id, uint32_t bytes);
uint32_t kiln_audio_stream_open(KilnAudio *a, int32_t id);
void kiln_audio_stream_close(KilnAudio *a, int32_t id);
double kiln_audio_time(KilnAudio *a);
float kiln_audio_peak(KilnAudio *a);
uint32_t kiln_audio_active(KilnAudio *a);
const float *kiln_audio_out(KilnAudio *a);
// Audio thread: render `frames` frames of interleaved stereo (2 floats per frame) for the
// block at absolute frame `position`.
void kiln_audio_render(KilnAudio *a, double position, uint32_t frames);
/* Writes frames * 2 interleaved stereo floats; position is measured in frames. */
void kiln_audio_render_into(KilnAudio *a, double position, float *out, uint32_t frames);

// --- Physics: rapier behind one call; arguments and results travel through the scratch ---
typedef struct KilnPhysics KilnPhysics;

KilnPhysics *kiln_physics_new(float pixels_per_meter);
void kiln_physics_free(KilnPhysics *p);
float *kiln_physics_scratch(KilnPhysics *p);
uint32_t kiln_physics_scratch_words(KilnPhysics *p);
int32_t kiln_physics_call(KilnPhysics *p, uint32_t op, uint32_t words);
const float *kiln_physics_transforms(KilnPhysics *p);
uint32_t kiln_physics_transform_count(KilnPhysics *p);
const float *kiln_physics_events(KilnPhysics *p);
uint32_t kiln_physics_event_count(KilnPhysics *p);

// --- Rendering: the wgpu renderer on a CAMetalLayer (feature "render") ---------------------
typedef struct KilnRenderer KilnRenderer;

KilnRenderer *kiln_render_new_metal_layer(void *layer, uint32_t width, uint32_t height, uint32_t max_quads);
void kiln_render_free(KilnRenderer *r);
void kiln_render_resize(KilnRenderer *r, uint32_t width, uint32_t height);
void kiln_render_upload_texture(KilnRenderer *r, uint32_t slot, uint32_t width, uint32_t height, const uint8_t *rgba);
// Draw the kernel's frame (10 floats per vertex, the command words and the post array);
// with `capture` the presented image is read back for kiln_render_capture_*.
const char *kiln_physics3d_json(const uint8_t *input, uint32_t len);
uint64_t kiln_render_mesh_resource(const KilnRenderer *r, uint32_t index);
int32_t kiln_render_mesh(KilnRenderer *r, const uint8_t *bytes, uint32_t len);
int32_t kiln_render_frame(KilnRenderer *r, const float *vertices, uint32_t vertex_count, const uint32_t *commands, uint32_t command_count, const float *post, uint32_t post_len, int32_t capture);
uint32_t kiln_render_capture_size(KilnRenderer *r, uint32_t *width, uint32_t *height);
uint32_t kiln_render_capture_read(KilnRenderer *r, uint8_t *out, uint32_t cap);

#ifdef __cplusplus
}
#endif
#endif
