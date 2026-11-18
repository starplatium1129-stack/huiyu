#include "live2d_model.h"
#include "CubismFramework.hpp"
#include "ICubismAllocator.hpp"
#include "Rendering/CubismRenderer.hpp"
#include <cstdio>
#include <cstdlib>
#include <malloc.h>
#include <mutex>

using namespace Live2D::Cubism::Framework;

namespace Live2D { namespace Cubism { namespace Framework { namespace Rendering {
// Platform backends (OpenGL/D3D/Metal/Vulkan) normally define this static;
// we render via wgpu in Rust, so this is a no-op.
void CubismRenderer::StaticRelease()
{
}
}}}} // namespace Live2D::Cubism::Framework::Rendering

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

extern "C" int l2d_initialize(void)
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
