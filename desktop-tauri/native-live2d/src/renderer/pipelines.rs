//! Device-wide pipelines and initial renderer construction.
use super::*;

impl Renderer {
    pub fn new(
        device: Arc<wgpu::Device>,
        queue: Arc<wgpu::Queue>,
        format: wgpu::TextureFormat,
    ) -> Renderer {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("live2d-shader"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });

        let tex_layout = create_tex_layout(&device);
        let uniform_layout = create_uniform_layout(&device);
        let main_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("live2d-main-layout"),
            bind_group_layouts: &[&tex_layout, &tex_layout, &uniform_layout],
            push_constant_ranges: &[],
        });

        // Mask coordinates outside the render target must sample the edge,
        // not wrap into another part of the mask atlas.
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("live2d-sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Nearest,
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            ..Default::default()
        });

        // Shared 1x1 white mask texture for non-masked drawables (group1 must
        // be bound on all pipelines; fs_main ignores it).
        let white = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("live2d-white-mask"),
            size: wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &white,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &[255, 255, 255, 255],
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(4),
                rows_per_image: Some(1),
            },
            wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
        );
        let white_view = white.create_view(&wgpu::TextureViewDescriptor::default());
        let white_mask_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("live2d-white-mask-bg"),
            layout: &tex_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&white_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
            ],
        });

        let blends = [
            BlendKind::Normal,
            BlendKind::Add,
            BlendKind::Multiply,
            BlendKind::Screen,
        ];
        let mut standard = Vec::with_capacity(4);
        let mut masked = Vec::with_capacity(4);
        for blend in blends {
            standard.push(make_pipeline(
                &device,
                &module,
                &main_layout,
                false,
                blend,
                format,
                PipelineKind::Main,
            ));
            masked.push(make_pipeline(
                &device,
                &module,
                &main_layout,
                true,
                blend,
                format,
                PipelineKind::Main,
            ));
        }
        // Each mask stores coverage in one R8 channel at the full render resolution.
        // Union blending preserves the previous RGBA alpha precision exactly.
        let mask = make_pipeline(
            &device,
            &module,
            &main_layout,
            false,
            BlendKind::Normal,
            MASK_TEXTURE_FORMAT,
            PipelineKind::Mask,
        );

        // 2x supersample blit pipeline: samples the offscreen supersample
        // texture (group 0 = texture + sampler) with linear filtering and
        // writes the downscaled frame into the swapchain surface.
        let ss_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("live2d-ss-blit-layout"),
            bind_group_layouts: &[&tex_layout],
            push_constant_ranges: &[],
        });
        let ss_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("live2d-ss-blit"),
            layout: Some(&ss_layout),
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("vs_blit"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs_blit"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(wgpu::BlendState::REPLACE),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        Renderer {
            device,
            queue,
            format,
            pipelines: Pipelines {
                standard: standard.try_into().unwrap(),
                masked: masked.try_into().unwrap(),
                mask,
            },
            tex_layout,
            uniform_layout,
            sampler,
            white_mask_bg,
            uniform_cache: None,
            model_cache: None,
            drawables_scratch: Vec::new(),
            upload_buffer: None,
            upload_capacity: 0,
            upload_staging: Vec::new(),
            texture_upload: TextureUploadState {
                buffer: None,
                capacity: 0,
            },
            resource_stats: RenderResourceStats::default(),
            stats: RenderStats::default(),
            ss_texture: None,
            ss_bg: None,
            ss_pipeline,
        }
    }
}

fn blend_state(kind: BlendKind, premultiplied: bool) -> wgpu::BlendState {
    // Verified against the reference ayagami renderer (and VTube Studio).
    use wgpu::{BlendFactor, BlendOperation};
    let (src_c, dst_c, src_a, dst_a) = if premultiplied {
        match kind {
            BlendKind::Normal => (
                BlendFactor::One,
                BlendFactor::OneMinusSrcAlpha,
                BlendFactor::One,
                BlendFactor::OneMinusSrcAlpha,
            ),
            BlendKind::Add => (
                BlendFactor::One,
                BlendFactor::One,
                BlendFactor::Zero,
                BlendFactor::One,
            ),
            BlendKind::Multiply => (
                BlendFactor::Dst,
                BlendFactor::OneMinusSrcAlpha,
                BlendFactor::Zero,
                BlendFactor::One,
            ),
            BlendKind::Screen => (
                BlendFactor::OneMinusDst,
                BlendFactor::One,
                BlendFactor::One,
                BlendFactor::One,
            ),
        }
    } else {
        match kind {
            BlendKind::Normal => (
                BlendFactor::SrcAlpha,
                BlendFactor::OneMinusSrcAlpha,
                BlendFactor::SrcAlpha,
                BlendFactor::OneMinusSrcAlpha,
            ),
            BlendKind::Add => (
                BlendFactor::SrcAlpha,
                BlendFactor::One,
                BlendFactor::SrcAlpha,
                BlendFactor::One,
            ),
            BlendKind::Multiply => (
                BlendFactor::Dst,
                BlendFactor::OneMinusSrcAlpha,
                BlendFactor::SrcAlpha,
                BlendFactor::OneMinusSrcAlpha,
            ),
            BlendKind::Screen => (
                BlendFactor::OneMinusDst,
                BlendFactor::One,
                BlendFactor::SrcAlpha,
                BlendFactor::One,
            ),
        }
    };
    wgpu::BlendState {
        color: wgpu::BlendComponent {
            src_factor: src_c,
            dst_factor: dst_c,
            operation: BlendOperation::Add,
        },
        alpha: wgpu::BlendComponent {
            src_factor: src_a,
            dst_factor: dst_a,
            operation: BlendOperation::Add,
        },
    }
}

fn create_tex_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("live2d-tex-layout"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            },
        ],
    })
}

fn create_uniform_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("live2d-uniform-layout"),
        entries: &[wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: true,
                min_binding_size: None,
            },
            count: None,
        }],
    })
}

fn make_pipeline(
    device: &wgpu::Device,
    module: &wgpu::ShaderModule,
    layout: &wgpu::PipelineLayout,
    masked: bool,
    blend: BlendKind,
    format: wgpu::TextureFormat,
    kind: PipelineKind,
) -> wgpu::RenderPipeline {
    let position_layout = wgpu::VertexBufferLayout {
        array_stride: 8,
        step_mode: wgpu::VertexStepMode::Vertex,
        attributes: &[wgpu::VertexAttribute {
            format: wgpu::VertexFormat::Float32x2,
            offset: 0,
            shader_location: 0,
        }],
    };
    let uv_layout = wgpu::VertexBufferLayout {
        array_stride: 8,
        step_mode: wgpu::VertexStepMode::Vertex,
        attributes: &[wgpu::VertexAttribute {
            format: wgpu::VertexFormat::Float32x2,
            offset: 0,
            shader_location: 1,
        }],
    };
    let targets = [Some(wgpu::ColorTargetState {
        format,
        blend: Some(if kind == PipelineKind::Mask {
            // Mask channel pass: out = src + dst * (1 - src), matching the
            // reference renderer (avoids squared-alpha darkening).
            wgpu::BlendState {
                color: wgpu::BlendComponent {
                    src_factor: wgpu::BlendFactor::One,
                    dst_factor: wgpu::BlendFactor::OneMinusSrc,
                    operation: wgpu::BlendOperation::Add,
                },
                alpha: wgpu::BlendComponent {
                    src_factor: wgpu::BlendFactor::One,
                    dst_factor: wgpu::BlendFactor::OneMinusSrc,
                    operation: wgpu::BlendOperation::Add,
                },
            }
        } else {
            blend_state(blend, true)
        }),
        write_mask: if kind == PipelineKind::Mask {
            wgpu::ColorWrites::ALL
        } else if matches!(blend, BlendKind::Add | BlendKind::Multiply) {
            wgpu::ColorWrites::COLOR
        } else {
            wgpu::ColorWrites::ALL
        },
    })];
    let entry = if kind == PipelineKind::Mask {
        "fs_mask"
    } else if matches!(blend, BlendKind::Multiply) {
        if masked {
            "fs_multiply_masked"
        } else {
            "fs_multiply"
        }
    } else if masked {
        "fs_masked"
    } else {
        "fs_main"
    };
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(entry),
        layout: Some(layout),
        vertex: wgpu::VertexState {
            module,
            entry_point: Some("vs_main"),
            compilation_options: Default::default(),
            buffers: &[position_layout, uv_layout],
        },
        fragment: Some(wgpu::FragmentState {
            module,
            entry_point: Some(entry),
            compilation_options: Default::default(),
            targets: &targets,
        }),
        primitive: wgpu::PrimitiveState {
            topology: wgpu::PrimitiveTopology::TriangleList,
            strip_index_format: None,
            front_face: wgpu::FrontFace::Ccw,
            cull_mode: None,
            unclipped_depth: false,
            polygon_mode: wgpu::PolygonMode::Fill,
            conservative: false,
        },
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        multiview: None,
        cache: None,
    })
}
