/*
 * Native Live2D runtime glue (C++).
 *
 * Wraps the official Cubism SDK for Native 5-r.5 framework classes behind a
 * small C API. Everything here is official framework behavior: motion queue +
 * priorities, expressions, physics, pose, eye blink and hit tests run exactly
 * like the reference samples; only the renderer is replaced (wgpu in Rust).
 */

#include "live2d_model.h"

#include <new>
#include <mutex>
#include <cstdlib>
#include <cstring>

#include "CubismFramework.hpp"
#include "ICubismAllocator.hpp"
#include "CubismModelSettingJson.hpp"
#include "Model/CubismMoc.hpp"
#include "Model/CubismModel.hpp"
#include "Motion/CubismMotionManager.hpp"
#include "Motion/CubismExpressionMotionManager.hpp"
#include "Motion/CubismMotion.hpp"
#include "Motion/CubismExpressionMotion.hpp"
#include "Physics/CubismPhysics.hpp"
#include "Effect/CubismPose.hpp"
#include "Effect/CubismEyeBlink.hpp"
#include "Id/CubismId.hpp"
#include "Id/CubismIdManager.hpp"
#include "Utils/CubismJson.hpp"
#include "Type/csmVector.hpp"
#include "Type/csmMap.hpp"

using namespace Live2D::Cubism::Framework;
using namespace Live2D::Cubism;

namespace Live2D { namespace Cubism { namespace Framework { namespace Rendering {
// Platform backends (OpenGL/D3D/Metal/Vulkan) normally define this static;
// we render via wgpu in Rust, so this is a no-op.
void CubismRenderer::StaticRelease()
{
}
}}}} // namespace Live2D::Cubism::Framework::Rendering
using namespace Live2D::Cubism::Core;

class AicsAllocator : public ICubismAllocator
{
public:
    void* Allocate(const csmSizeType size) override { return std::malloc(size); }
    void Deallocate(void* memory) override { std::free(memory); }
    void* AllocateAligned(const csmSizeType size, const csmUint32 alignment) override
    {
        return _aligned_malloc(size, alignment);
    }
    void DeallocateAligned(void* alignedMemory) override { _aligned_free(alignedMemory); }
};

static AicsAllocator s_allocator;
static std::once_flag s_frameworkInitFlag;

static void sdkLog(const csmChar* message)
{
    fputs("[cubism] ", stderr);
    fputs(message, stderr);
    fputc('\n', stderr);
}

static int initializeFramework()
{
    int result = 0;
    std::call_once(s_frameworkInitFlag, [&result]() {
        CubismFramework::Option option;
        option.LoggingLevel = CubismFramework::Option::LogLevel_Verbose;
        option.LogFunction = sdkLog;
        if (!CubismFramework::StartUp(&s_allocator, &option))
        {
            result = 1;
            return;
        }
        CubismFramework::Initialize();
    });
    return result;
}

struct l2d_model
{
    CubismMoc* moc = nullptr;
    CubismModel* model = nullptr;
    CubismModelSettingJson* setting = nullptr;

    CubismMotionManager* motionManager = nullptr;
    CubismExpressionMotionManager* expressionManager = nullptr;
    CubismEyeBlink* eyeBlink = nullptr;
    CubismPose* pose = nullptr;
    CubismPhysics* physics = nullptr;

    /* group -> vector of motions (index == vector position) */
    csmMap<csmString, csmVector<ACubismMotion*>*> motionGroups;
    /* name -> expression */
    csmMap<csmString, ACubismMotion*> expressions;

    ~l2d_model()
    {
        if (model && moc) { moc->DeleteModel(model); }
        if (moc) { CubismMoc::Delete(moc); }
        delete setting;
        delete motionManager;
        delete expressionManager;
        if (eyeBlink) { CubismEyeBlink::Delete(eyeBlink); }
        if (pose) { CubismPose::Delete(pose); }
        if (physics) { CubismPhysics::Delete(physics); }
        for (csmMap<csmString, csmVector<ACubismMotion*>*>::const_iterator it = motionGroups.Begin();
             it != motionGroups.End(); ++it)
        {
            csmVector<ACubismMotion*>* motions = it->Second;
            if (motions)
            {
                for (csmUint32 i = 0; i < motions->GetSize(); ++i)
                {
                    if (motions->At(i)) { ACubismMotion::Delete(motions->At(i)); }
                }
                delete motions;
            }
        }
        for (csmMap<csmString, ACubismMotion*>::const_iterator it = expressions.Begin();
             it != expressions.End(); ++it)
        {
            if (it->Second) { ACubismMotion::Delete(it->Second); }
        }
        /* updaters were removed: CubismUpdateScheduler would CSM_DELETE them on
           member destruction (double free). Update order is now manual in
           l2d_model_update. */
    }
};

extern "C" {

int l2d_initialize(void)
{
    return initializeFramework();
}

l2d_model* l2d_model_create(const uint8_t* mocData, size_t mocSize,
                            const uint8_t* model3Data, size_t model3Size)
{
    if (!mocData || mocSize == 0 || !model3Data || model3Size == 0) { return nullptr; }
    if (initializeFramework() != 0) { return nullptr; }

    l2d_model* m = new (std::nothrow) l2d_model(); fprintf(stderr, "[l2d] alloc ok\n");
    if (!m) { return nullptr; }

    fprintf(stderr, "[l2d] setting ctor...\n");
    m->setting = new (std::nothrow) CubismModelSettingJson(
        reinterpret_cast<const csmByte*>(model3Data), static_cast<csmSizeInt>(model3Size));
    if (!m->setting)
    {
        delete m;
        return nullptr;
    }

    fprintf(stderr, "[l2d] moc create...\n");
    m->moc = CubismMoc::Create(reinterpret_cast<const csmByte*>(mocData), static_cast<csmSizeInt>(mocSize));
    if (!m->moc)
    {
        delete m;
        return nullptr;
    }

    fprintf(stderr, "[l2d] model create...\n");
    fflush(stderr);
    m->model = m->moc->CreateModel();
    fprintf(stderr, "[l2d] model=%p\n", static_cast<void*>(m->model));
    fflush(stderr);
    if (!m->model)
    {
        fprintf(stderr, "[l2d] model create FAILED\n");
        fflush(stderr);
        delete m;
        return nullptr;
    }

    fprintf(stderr, "[l2d] save params...\n");
    fflush(stderr);
    m->model->SaveParameters();
    fprintf(stderr, "[l2d] params saved ok\n");
    fflush(stderr);
    m->motionManager = new (std::nothrow) CubismMotionManager();
    m->expressionManager = new (std::nothrow) CubismExpressionMotionManager();
    fprintf(stderr, "[l2d] eye blink...\n");
    fflush(stderr);
    {
        Utils::CubismJson* dbg = Utils::CubismJson::Create(
            reinterpret_cast<const csmByte*>(model3Data), static_cast<csmSizeInt>(model3Size));
        fprintf(stderr, "[l2d] dbg json=%p err=%s\n", static_cast<void*>(dbg),
                dbg ? (dbg->GetParseError() ? dbg->GetParseError() : "ok") : "create-null");
        fflush(stderr);
        if (dbg) { Utils::CubismJson::Delete(dbg); }
    }
    fprintf(stderr, "[l2d] motions=%d hitareas=%d\n",
            m->setting->GetMotionGroupCount(), m->setting->GetHitAreasCount());
    fflush(stderr);
    const csmInt32 blinkCount = m->setting->GetEyeBlinkParameterCount();
    fprintf(stderr, "[l2d] blink count=%d\n", blinkCount);
    fflush(stderr);
    m->eyeBlink = CubismEyeBlink::Create(m->setting);
    if (!m->motionManager || !m->expressionManager || !m->eyeBlink)
    {
        delete m;
        return nullptr;
    }

    fprintf(stderr, "[l2d] updaters...\n");
    /* updaters replaced by manual update calls in l2d_model_update. */
    return m;
}

void l2d_model_destroy(l2d_model* m)
{
    delete m;
}

int l2d_model_add_motion(l2d_model* m, const char* group, int index,
                         const uint8_t* json, size_t size)
{
    if (!m || !group || !json || size == 0) { return 1; }
    csmString groupName(group);

    if (!m->motionGroups.IsExist(groupName))
    {
        m->motionGroups[groupName] = new (std::nothrow) csmVector<ACubismMotion*>();
    }
    csmVector<ACubismMotion*>* motions = m->motionGroups[groupName];
    if (!motions) { return 1; }

    ACubismMotion* motion = CubismMotion::Create(
        reinterpret_cast<const csmByte*>(json), static_cast<csmSizeInt>(size));
    if (!motion)
    {
        return 1;
    }

    /* model3.json group-level fade times override the motion file values. */
    const csmFloat32 fadeIn = m->setting->GetMotionFadeInTimeValue(groupName.GetRawString(), index);
    const csmFloat32 fadeOut = m->setting->GetMotionFadeOutTimeValue(groupName.GetRawString(), index);
    if (fadeIn >= 0.0f) { motion->SetFadeInTime(fadeIn); }
    if (fadeOut >= 0.0f) { motion->SetFadeOutTime(fadeOut); }

    while (static_cast<csmInt32>(motions->GetSize()) <= index)
    {
        motions->PushBack(nullptr);
    }
    (*motions)[index] = motion;
    return 0;
}

int l2d_model_add_expression(l2d_model* m, const char* name,
                             const uint8_t* json, size_t size)
{
    if (!m || !name || !json || size == 0) { return 1; }
    ACubismMotion* expression = CubismExpressionMotion::Create(
        reinterpret_cast<const csmByte*>(json), static_cast<csmSizeInt>(size));
    if (!expression) { return 1; }
    m->expressions[csmString(name)] = expression;
    return 0;
}

int l2d_model_load_physics(l2d_model* m, const uint8_t* json, size_t size)
{
    if (!m || !json || size == 0) { return 1; }
    m->physics = CubismPhysics::Create(reinterpret_cast<const csmByte*>(json), static_cast<csmSizeInt>(size));
    if (!m->physics) { return 1; }
    /* physics driven manually in l2d_model_update */    return 0;
}

int l2d_model_load_pose(l2d_model* m, const uint8_t* json, size_t size)
{
    if (!m || !json || size == 0) { return 1; }
    m->pose = CubismPose::Create(reinterpret_cast<const csmByte*>(json), static_cast<csmSizeInt>(size));
    if (!m->pose) { return 1; }
    /* pose driven manually in l2d_model_update */    return 0;
}

int64_t l2d_model_start_motion(l2d_model* m, const char* group, int index, int priority)
{
    if (!m || !group || index < 0) { return 0; }
    csmString groupName(group);
    if (!m->motionGroups.IsExist(groupName)) { return 0; }
    csmVector<ACubismMotion*>* motions = m->motionGroups[groupName];
    if (!motions || static_cast<csmUint32>(index) >= motions->GetSize()) { return 0; }
    ACubismMotion* motion = motions->At(index);
    if (!motion) { return 0; }
    CubismMotionQueueEntryHandle handle =
        m->motionManager->StartMotionPriority(motion, false, priority);
    return handle ? static_cast<int64_t>(reinterpret_cast<intptr_t>(handle)) : 0;
}

int64_t l2d_model_start_expression(l2d_model* m, const char* name, int priority)
{
    (void)priority;
    if (!m || !name) { return 0; }
    csmString exprName(name);
    if (!m->expressions.IsExist(exprName)) { return 0; }
    CubismMotionQueueEntryHandle handle =
        m->expressionManager->StartMotion(m->expressions[exprName], false);
    return handle ? static_cast<int64_t>(reinterpret_cast<intptr_t>(handle)) : 0;
}

int l2d_model_is_finished(l2d_model* m, int64_t handle)
{
    if (!m || handle <= 0) { return 1; }
    return m->motionManager->IsFinished(
        reinterpret_cast<CubismMotionQueueEntryHandle>(static_cast<intptr_t>(handle))) ? 1 : 0;
}

void l2d_model_set_parameter(l2d_model* m, const char* id, float value, float weight)
{
    if (!m || !id || !m->model) { return; }
    CubismIdHandle paramId = CubismFramework::GetIdManager()->GetId(id);
    m->model->SetParameterValue(m->model->GetParameterIndex(paramId), value, weight);
}

float l2d_model_get_parameter(l2d_model* m, const char* id)
{
    if (!m || !id || !m->model) { return 0.0f; }
    CubismIdHandle paramId = CubismFramework::GetIdManager()->GetId(id);
    return m->model->GetParameterValue(m->model->GetParameterIndex(paramId));
}

/* TEMP DIAG (2026-08-16): reset every parameter to its moc3 default value. */
void l2d_model_reset_all_parameters(l2d_model* m)
{
    if (!m || !m->model) { return; }
    const csmInt32 count = m->model->GetParameterCount();
    for (csmInt32 i = 0; i < count; ++i)
    {
        m->model->SetParameterValue(i, m->model->GetParameterDefaultValue(i));
    }
}

void l2d_model_update(l2d_model* m, float deltaTimeSeconds)
{
    if (!m || !m->model) { return; }

    m->motionManager->UpdateMotion(m->model, deltaTimeSeconds);
    m->expressionManager->UpdateMotion(m->model, deltaTimeSeconds);
    if (m->eyeBlink)
    {
        m->eyeBlink->UpdateParameters(m->model, deltaTimeSeconds);
    }
    if (m->physics) { m->physics->Evaluate(m->model, deltaTimeSeconds); }
    if (m->pose) { m->pose->UpdateParameters(m->model, deltaTimeSeconds); }
    m->model->Update();
}

float l2d_model_canvas_width(l2d_model* m)
{
    return m && m->model ? m->model->GetCanvasWidth() : 0.0f;
}

float l2d_model_canvas_height(l2d_model* m)
{
    return m && m->model ? m->model->GetCanvasHeight() : 0.0f;
}

int l2d_model_parameter_index(l2d_model* m, const char* id)
{
    if (!m || !id || !m->model) { return -1; }
    CubismIdHandle paramId = CubismFramework::GetIdManager()->GetId(id);
    return m->model->GetParameterIndex(paramId);
}

int l2d_model_drawable_count(l2d_model* m)
{
    return m && m->model ? m->model->GetDrawableCount() : 0;
}

int l2d_model_drawable_index(l2d_model* m, const char* id)
{
    if (!m || !id || !m->model) { return -1; }
    CubismIdHandle drawableId = CubismFramework::GetIdManager()->GetId(id);
    return m->model->GetDrawableIndex(drawableId);
}

int l2d_model_drawable_vertex_count(l2d_model* m, int index)
{
    return m && m->model ? m->model->GetDrawableVertexCount(index) : 0;
}

const float* l2d_model_drawable_positions(l2d_model* m, int index)
{
    if (!m || !m->model) { return nullptr; }
    return reinterpret_cast<const float*>(m->model->GetDrawableVertexPositions(index));
}

const float* l2d_model_drawable_uvs(l2d_model* m, int index)
{
    if (!m || !m->model) { return nullptr; }
    return reinterpret_cast<const float*>(m->model->GetDrawableVertexUvs(index));
}

const uint16_t* l2d_model_drawable_indices(l2d_model* m, int index)
{
    if (!m || !m->model) { return nullptr; }
    return m->model->GetDrawableVertexIndices(index);
}

int l2d_model_drawable_index_count(l2d_model* m, int index)
{
    return m && m->model ? m->model->GetDrawableVertexIndexCount(index) : 0;
}

float l2d_model_drawable_opacity(l2d_model* m, int index)
{
    return m && m->model ? m->model->GetDrawableOpacity(index) : 0.0f;
}

int l2d_model_drawable_culling(l2d_model* m, int index)
{
    return m && m->model ? m->model->GetDrawableCulling(index) : 0;
}

int l2d_model_drawable_texture_index(l2d_model* m, int index)
{
    return m && m->model ? m->model->GetDrawableTextureIndex(index) : 0;
}

int l2d_model_drawable_visible(l2d_model* m, int index)
{
    return m && m->model ? m->model->GetDrawableDynamicFlagIsVisible(index) : 0;
}

int l2d_model_drawable_render_order(l2d_model* m, int index)
{
    return m && m->model ? m->model->GetRenderOrders()[index] : 0;
}

int l2d_model_drawable_color_blend(l2d_model* m, int index)
{
    if (!m || !m->model) { return L2D_COLOR_BLEND_NORMAL; }
    return m->model->GetDrawableBlendModeType(index).GetColorBlendType();
}

int l2d_model_drawable_alpha_blend(l2d_model* m, int index)
{
    if (!m || !m->model) { return L2D_ALPHA_BLEND_OVER; }
    return m->model->GetDrawableBlendModeType(index).GetAlphaBlendType();
}

void l2d_model_drawable_multiply_color(l2d_model* m, int index, float* rgba)
{
    if (!m || !m->model || !rgba) { return; }
    const Core::csmVector4 color = m->model->GetDrawableMultiplyColor(index);
    rgba[0] = color.X;
    rgba[1] = color.Y;
    rgba[2] = color.Z;
    rgba[3] = color.W;
}

void l2d_model_drawable_screen_color(l2d_model* m, int index, float* rgba)
{
    if (!m || !m->model || !rgba) { return; }
    const Core::csmVector4 color = m->model->GetDrawableScreenColor(index);
    rgba[0] = color.X;
    rgba[1] = color.Y;
    rgba[2] = color.Z;
    rgba[3] = color.W;
}

int l2d_model_drawable_mask_count(l2d_model* m, int index)
{
    return m && m->model ? m->model->GetDrawableMaskCounts()[index] : 0;
}

const int* l2d_model_drawable_masks(l2d_model* m, int index)
{
    if (!m || !m->model) { return nullptr; }
    return m->model->GetDrawableMasks()[index];
}

int l2d_model_drawable_inverted_mask(l2d_model* m, int index)
{
    return m && m->model ? m->model->GetDrawableInvertedMask(index) : 0;
}

int l2d_model_hit_test(l2d_model* m, const char* hitAreaId, float canvasX, float canvasY)
{
    if (!m || !m->model || !hitAreaId || !m->setting) { return 0; }

    /* model3.json HitAreas 是 Name -> Id(ArtMesh) 映射；先按 Name 匹配，
       再用映射后的 ArtMesh Id 取顶点包围盒（直接用 Name 查 drawable 永远失败）。 */
    const csmInt32 hitCount = m->setting->GetHitAreasCount();
    if (hitCount <= 0) { return 0; }

    if (getenv("L2D_DEBUG_HIT")) {
        fprintf(stderr, "[hit-c] want=%s hitCount=%d\n", hitAreaId, hitCount);
        for (csmInt32 h = 0; h < hitCount; ++h) {
            const char* name = m->setting->GetHitAreaName(h);
            const CubismIdHandle id = m->setting->GetHitAreaId(h);
            const csmInt32 idx = id ? m->model->GetDrawableIndex(id) : -1;
            if (idx >= 0) {
                const Core::csmVector2* p = m->model->GetDrawableVertexPositions(idx);
                const csmInt32 n = m->model->GetDrawableVertexCount(idx);
                csmFloat32 lx = p[0].X, hx = p[0].X, ly = p[0].Y, hy = p[0].Y;
                for (csmInt32 i = 1; i < n; ++i) {
                    lx = lx < p[i].X ? lx : p[i].X;
                    hx = hx > p[i].X ? hx : p[i].X;
                    ly = ly < p[i].Y ? ly : p[i].Y;
                    hy = hy > p[i].Y ? hy : p[i].Y;
                }
                fprintf(stderr, "[hit-c]   [%d] name=%s idx=%d bbox x[%.3f,%.3f] y[%.3f,%.3f]\n", h, name ? name : "?", idx, lx, hx, ly, hy);
            } else {
                fprintf(stderr, "[hit-c]   [%d] name=%s idx=%d\n", h, name ? name : "?", idx);
            }
        }
    }

    csmInt32 drawableIndex = -1;
    for (csmInt32 h = 0; h < hitCount; ++h)
    {
        const char* name = m->setting->GetHitAreaName(h);
        if (name && strcmp(name, hitAreaId) == 0)
        {
            drawableIndex = m->model->GetDrawableIndex(m->setting->GetHitAreaId(h));
            break;
        }
    }
    if (drawableIndex < 0) { return 0; }

    const Core::csmVector2* positions = m->model->GetDrawableVertexPositions(drawableIndex);
    const csmInt32 num = m->model->GetDrawableVertexCount(drawableIndex);
    if (num <= 0 || !positions) { return 0; }

    csmFloat32 left = positions[0].X;
    csmFloat32 right = positions[0].X;
    csmFloat32 top = positions[0].Y;
    csmFloat32 bottom = positions[0].Y;
    for (csmInt32 i = 1; i < num; ++i)
    {
        if (positions[i].X < left) { left = positions[i].X; }
        if (positions[i].X > right) { right = positions[i].X; }
        if (positions[i].Y < top) { top = positions[i].Y; }
        if (positions[i].Y > bottom) { bottom = positions[i].Y; }
    }

    return (left <= canvasX && canvasX <= right && top <= canvasY && canvasY <= bottom) ? 1 : 0;
}

} /* extern "C" */
