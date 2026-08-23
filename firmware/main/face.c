// Chiki's animated face plus the swipe-left curiosity map. All LVGL calls stay
// in LVGL context; pipeline/progress tasks only publish atomics or queue data.
#include "face.h"
#include "pipeline.h"
#include "progress.h"
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include "bsp/esp32_s3_touch_amoled_1_8.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "lvgl.h"

#define COL_FACE  lv_color_hex(0x00D9FF)
#define COL_DIM   lv_color_hex(0x0077AA)
#define SCREEN_W  BSP_LCD_H_RES
#define MAP_TICKS (15000 / 40)
#define EYE_X     78
#define EYE_Y     (-60)

static atomic_int g_state = FACE_BOOTING;
static lv_obj_t *s_face_page, *s_map_page;
static lv_obj_t *s_eye_l, *s_eye_r, *s_mouth, *s_smile, *s_frown, *s_dots[3];
static lv_obj_t *s_cells[PROGRESS_DAY_COUNT], *s_summary, *s_latest;
static QueueHandle_t s_progress_queue;
static progress_snapshot_t s_progress;
static bool s_have_progress, s_map_open, s_gesture;
static int s_map_ticks;

typedef struct { int eye_w, eye_h, eye_dy; } geom_t;
static geom_t cur, tgt;

static void show(lv_obj_t *o, bool on)
{
    if (on) lv_obj_clear_flag(o, LV_OBJ_FLAG_HIDDEN);
    else lv_obj_add_flag(o, LV_OBJ_FLAG_HIDDEN);
}

static int ease(int c, int t)
{
    int d = t - c;
    if (!d) return c;
    int step = d / 3;
    if (!step) step = d > 0 ? 1 : -1;
    return c + step;
}

static void enter_state(int st)
{
    show(s_smile, st == FACE_IDLE);
    show(s_frown, st == FACE_SAD);
    show(s_mouth, st == FACE_SPEAKING || st == FACE_LISTENING);
    for (int i = 0; i < 3; i++) show(s_dots[i], st == FACE_THINKING);

    switch (st) {
    case FACE_BOOTING:   tgt = (geom_t){ 96, 10, 0 };   break;
    case FACE_IDLE:      tgt = (geom_t){ 96, 112, 0 };  break;
    case FACE_LISTENING: tgt = (geom_t){ 108, 124, -4 };
        lv_obj_set_size(s_mouth, 42, 42);
        lv_obj_set_style_radius(s_mouth, LV_RADIUS_CIRCLE, 0);
        lv_obj_align(s_mouth, LV_ALIGN_CENTER, 0, 108);
        break;
    case FACE_THINKING:  tgt = (geom_t){ 72, 84, -16 }; break;
    case FACE_SPEAKING:  tgt = (geom_t){ 96, 104, 0 };
        lv_obj_set_style_radius(s_mouth, 14, 0);
        break;
    case FACE_SAD:       tgt = (geom_t){ 96, 52, 12 };  break;
    }
}

static lv_color_t intensity_color(uint8_t level)
{
    static const uint32_t colors[] = { 0x10232A, 0x07505E, 0x087A8C, 0x00AFC7, 0x00D9FF };
    return lv_color_hex(colors[level <= 4 ? level : 4]);
}

static const char *topic_hebrew(const char *id)
{
    static const struct { const char *id, *he; } topics[] = {
        {"space", "החלל"}, {"jungle", "הג׳ונגל"}, {"detectives", "בלשים"},
        {"oceans", "האוקיינוסים"}, {"dinosaurs", "דינוזאורים"}, {"inventors", "ממציאים"},
        {"human_body", "גוף האדם"}, {"ancient_egypt", "מצרים העתיקה"},
        {"insects", "עולם החרקים"}, {"weather", "מזג האוויר"}, {"other", "תגלית אחרת"},
    };
    for (size_t i = 0; i < sizeof(topics) / sizeof(topics[0]); i++) {
        if (!strcmp(id, topics[i].id)) return topics[i].he;
    }
    return NULL;
}

static void set_cell_opa(void *obj, int32_t value)
{
    lv_obj_set_style_bg_opa(obj, value, 0);
}

static void apply_progress(const progress_snapshot_t *next)
{
    bool animate = s_have_progress && next->revision > s_progress.revision;
    for (int i = 0; i < PROGRESS_DAY_COUNT; i++) {
        if (i > next->today_index) {
            show(s_cells[i], false);
            continue;
        }
        show(s_cells[i], true);
        lv_obj_set_style_bg_color(s_cells[i], intensity_color(next->days[i]), 0);
        if (animate && next->days[i] > s_progress.days[i]) {
            lv_anim_t a;
            lv_anim_init(&a);
            lv_anim_set_var(&a, s_cells[i]);
            lv_anim_set_exec_cb(&a, set_cell_opa);
            lv_anim_set_values(&a, LV_OPA_30, LV_OPA_COVER);
            lv_anim_set_duration(&a, 220);
            lv_anim_set_path_cb(&a, lv_anim_path_ease_out);
            lv_anim_start(&a);
        } else {
            lv_obj_set_style_bg_opa(s_cells[i], LV_OPA_COVER, 0);
        }
    }
    s_progress = *next;
    s_have_progress = true;
    lv_label_set_text_fmt(s_summary, "%lu תגליות · %u נושאים",
                          (unsigned long)next->lifetime_explorations,
                          (unsigned)next->lifetime_topics);
    const char *topic = topic_hebrew(next->latest_topic);
    if (topic) lv_label_set_text_fmt(s_latest, "לאחרונה: %s", topic);
    else lv_label_set_text(s_latest, "מעניין מה נגלה היום");
}

static void set_page_x(void *obj, int32_t value)
{
    lv_obj_set_x(obj, value);
}

static void animate_page(lv_obj_t *page, int from, int to)
{
    lv_anim_delete(page, set_page_x);
    lv_anim_t a;
    lv_anim_init(&a);
    lv_anim_set_var(&a, page);
    lv_anim_set_exec_cb(&a, set_page_x);
    lv_anim_set_values(&a, from, to);
    lv_anim_set_duration(&a, 220);
    lv_anim_set_path_cb(&a, lv_anim_path_ease_out);
    lv_anim_start(&a);
}

static void open_map(void)
{
    if (s_map_open) return;
    s_map_open = true;
    s_map_ticks = 0;
    animate_page(s_face_page, 0, -SCREEN_W);
    animate_page(s_map_page, SCREEN_W, 0);
    progress_request_refresh();
}

static void close_map(void)
{
    if (!s_map_open) return;
    s_map_open = false;
    animate_page(s_face_page, -SCREEN_W, 0);
    animate_page(s_map_page, 0, SCREEN_W);
}

static void timer_cb(lv_timer_t *t)
{
    static int last_state = -1, tick = 0, blink = 0;
    progress_snapshot_t pending;
    if (xQueueReceive(s_progress_queue, &pending, 0) == pdTRUE) apply_progress(&pending);
    if (s_map_open && ++s_map_ticks >= MAP_TICKS) close_map();

    int st = atomic_load(&g_state);
    if (st != last_state) {
        last_state = st;
        tick = 0;
        blink = 0;
        enter_state(st);
    }
    tick++;

    int eye_h = tgt.eye_h;
    if (st == FACE_IDLE || st == FACE_LISTENING) {
        if (blink) {
            blink--;
            eye_h = 10;
        } else if (tick % 75 == 0) {
            blink = 3;
        }
    }

    cur.eye_w = ease(cur.eye_w, tgt.eye_w);
    cur.eye_h = blink ? eye_h : ease(cur.eye_h, eye_h);
    cur.eye_dy = ease(cur.eye_dy, tgt.eye_dy);
    lv_obj_set_size(s_eye_l, cur.eye_w, cur.eye_h);
    lv_obj_set_size(s_eye_r, cur.eye_w, cur.eye_h);
    lv_obj_align(s_eye_l, LV_ALIGN_CENTER, -EYE_X, EYE_Y + cur.eye_dy);
    lv_obj_align(s_eye_r, LV_ALIGN_CENTER, EYE_X, EYE_Y + cur.eye_dy);

    if (st == FACE_SPEAKING) {
        static const uint8_t bounce[] = { 20, 46, 64, 38, 52, 24, 58, 30, 44, 16 };
        int h = bounce[(tick / 2) % sizeof(bounce)];
        lv_obj_set_size(s_mouth, 130, h);
        lv_obj_align(s_mouth, LV_ALIGN_CENTER, 0, 112);
    } else if (st == FACE_THINKING) {
        for (int i = 0; i < 3; i++) {
            int phase = (tick / 4 + 2 - i) % 3;
            lv_obj_set_style_bg_opa(s_dots[i], phase == 0 ? LV_OPA_COVER : LV_OPA_40, 0);
        }
    }
}

static void touch_cb(lv_event_t *e)
{
    lv_event_code_t code = lv_event_get_code(e);
    if (code == LV_EVENT_PRESSED) {
        s_gesture = false;
    } else if (code == LV_EVENT_GESTURE && !pipeline_session_active() &&
               atomic_load(&g_state) == FACE_IDLE) {
        s_gesture = true;
        lv_dir_t dir = lv_indev_get_gesture_dir(lv_indev_active());
        if (!s_map_open && dir == LV_DIR_LEFT) open_map();
        else if (s_map_open && dir == LV_DIR_RIGHT) close_map();
    } else if (code == LV_EVENT_SHORT_CLICKED && !s_gesture && !s_map_open) {
        pipeline_touch(true);
    }
}

static lv_obj_t *make_page(lv_obj_t *parent)
{
    lv_obj_t *page = lv_obj_create(parent);
    lv_obj_set_size(page, LV_PCT(100), LV_PCT(100));
    lv_obj_set_pos(page, 0, 0);
    lv_obj_set_style_bg_opa(page, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(page, 0, 0);
    lv_obj_set_style_pad_all(page, 0, 0);
    lv_obj_clear_flag(page, LV_OBJ_FLAG_SCROLLABLE | LV_OBJ_FLAG_CLICKABLE);
    return page;
}

static lv_obj_t *make_rect(lv_obj_t *parent, lv_color_t col, int radius)
{
    lv_obj_t *o = lv_obj_create(parent);
    lv_obj_set_style_bg_color(o, col, 0);
    lv_obj_set_style_bg_opa(o, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(o, 0, 0);
    lv_obj_set_style_radius(o, radius, 0);
    lv_obj_clear_flag(o, LV_OBJ_FLAG_SCROLLABLE | LV_OBJ_FLAG_CLICKABLE);
    return o;
}

static lv_obj_t *make_arc(lv_obj_t *parent, int start, int end, int y_ofs)
{
    lv_obj_t *a = lv_arc_create(parent);
    lv_obj_set_size(a, 150, 150);
    lv_obj_align(a, LV_ALIGN_CENTER, 0, y_ofs);
    lv_arc_set_bg_angles(a, start, end);
    lv_arc_set_angles(a, start, end);
    lv_obj_remove_style(a, NULL, LV_PART_KNOB);
    lv_obj_set_style_arc_opa(a, LV_OPA_TRANSP, LV_PART_MAIN);
    lv_obj_set_style_arc_color(a, COL_FACE, LV_PART_INDICATOR);
    lv_obj_set_style_arc_width(a, 12, LV_PART_INDICATOR);
    lv_obj_set_style_arc_rounded(a, true, LV_PART_INDICATOR);
    lv_obj_clear_flag(a, LV_OBJ_FLAG_CLICKABLE);
    return a;
}

static lv_obj_t *make_label(lv_obj_t *parent, const char *text, int y)
{
    lv_obj_t *label = lv_label_create(parent);
    lv_obj_set_width(label, 340);
    lv_label_set_text(label, text);
    lv_obj_set_style_text_font(label, &lv_font_dejavu_16_persian_hebrew, 0);
    lv_obj_set_style_text_color(label, COL_FACE, 0);
    lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_style_base_dir(label, LV_BASE_DIR_RTL, 0);
    lv_obj_align(label, LV_ALIGN_TOP_MID, 0, y);
    return label;
}

void face_init(void)
{
    s_progress_queue = xQueueCreate(1, sizeof(progress_snapshot_t));
    assert(s_progress_queue);
    bsp_display_lock(0);

    lv_obj_t *scr = lv_screen_active();
    lv_obj_set_style_bg_color(scr, lv_color_black(), 0);
    s_face_page = make_page(scr);
    s_map_page = make_page(scr);
    lv_obj_set_x(s_map_page, SCREEN_W);

    s_eye_l = make_rect(s_face_page, COL_FACE, 32);
    s_eye_r = make_rect(s_face_page, COL_FACE, 32);
    s_smile = make_arc(s_face_page, 35, 145, 40);
    s_frown = make_arc(s_face_page, 215, 325, 150);
    s_mouth = make_rect(s_face_page, COL_FACE, 14);
    show(s_mouth, false);

    for (int i = 0; i < 3; i++) {
        s_dots[i] = make_rect(s_face_page, COL_DIM, LV_RADIUS_CIRCLE);
        lv_obj_set_size(s_dots[i], 18, 18);
        lv_obj_align(s_dots[i], LV_ALIGN_CENTER, (i - 1) * 40, 110);
        show(s_dots[i], false);
    }

    make_label(s_map_page, "מפת הסקרנות", 30);
    s_summary = make_label(s_map_page, "עדיין אין תגליות במפה", 66);
    const int cell = 20, gap = 6, grid_x = 31, grid_y = 116;
    for (int col = 0; col < 12; col++) {
        for (int row = 0; row < 7; row++) {
            int i = col * 7 + row;
            s_cells[i] = make_rect(s_map_page, intensity_color(0), 5);
            lv_obj_set_size(s_cells[i], cell, cell);
            lv_obj_set_pos(s_cells[i], grid_x + col * (cell + gap), grid_y + row * (cell + gap));
            show(s_cells[i], false);
        }
    }
    s_latest = make_label(s_map_page, "מעניין מה נגלה היום", 330);
    lv_obj_t *hint = make_label(s_map_page, "החלק ימינה כדי לחזור", 390);
    lv_obj_set_style_text_color(hint, lv_color_hex(0x4C7780), 0);

    cur = (geom_t){ 96, 10, 0 };
    enter_state(FACE_BOOTING);

    lv_obj_t *touch = lv_obj_create(scr);
    lv_obj_set_size(touch, LV_PCT(100), LV_PCT(100));
    lv_obj_set_style_bg_opa(touch, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(touch, 0, 0);
    lv_obj_clear_flag(touch, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_add_event_cb(touch, touch_cb, LV_EVENT_ALL, NULL);

    lv_timer_create(timer_cb, 40, NULL);
    bsp_display_unlock();
}

void face_set_state(face_state_t state)
{
    atomic_store(&g_state, state);
}

void face_set_progress(const progress_snapshot_t *snapshot)
{
    if (s_progress_queue && snapshot) xQueueOverwrite(s_progress_queue, snapshot);
}
